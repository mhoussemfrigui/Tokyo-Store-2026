import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db/client";
import { authService } from "@/modules/auth/service";
import { apiKeyService } from "@/modules/api-key/service";
import { customerService } from "@/modules/customer/service";
import { customer_profiles } from "@/modules/customer/schema";
import { wishlistService } from "@/modules/wishlist/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { assertActorOutranksTarget, assertDisableKeepsAnAdmin } from "@/lib/rbac/guards";
import { isInternalAccount } from "@/lib/rbac/roster";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";
import { unsubscribeEmailFromMarketing } from "./unsubscribe";

export const deleteCustomerSchema = z.object({
  customerProfileId: z.string().uuid("ID profil invalide"),
});

/**
 * Workflow — admin deletes (archives) a customer.
 *
 * The profile is SOFT-deleted: orders, reviews and the coins ledger keep
 * their history. If a linked auth user exists AND it is a plain customer login
 * (NOT an internal account — see `isInternalAccount`), the account is disabled,
 * every active session revoked and its API keys revoked — same service calls AND
 * the same audit events (`user.disabled`, `user.sessions_revoked`,
 * `api_key.revoked`) as the disable-user workflow. Internal accounts (any
 * effective role grant or allow override) that happen to own a customer profile
 * are left untouched: their login is managed from the users panel, not here.
 *
 * SECURITY: a plain customer login can still be promoted later (an RBAC role
 * grant), and the "holds no grant" test is read fresh here, so disabling it is
 * privilege-relevant — we apply the SAME guards as the users panel: the actor
 * may not target their OWN account (self-lockout), must out-rank the linked
 * account, and the disable must not strip the last effective admin. All run
 * BEFORE any write so a denial aborts cleanly.
 *
 * FAIL-SAFE ORDER + IDEMPOTENT: the steps are separate autocommit writes (the
 * auth / api-key / newsletter services own their tables and take no tx), so the
 * order is chosen so that a failure at ANY point never leaves an archived
 * customer with a live login — the account is offboarded FIRST (disable →
 * sessions → API keys), then consent/visibility withdrawn, and the profile is
 * archived LAST (after its addresses). A failed run leaves the profile live, so
 * the operator's retry passes the lookup and finishes the job; an ALREADY
 * archived profile (a previous run, or the pre-fix order that archived first)
 * is accepted too and its offboarding completed instead of « Client
 * introuvable ». Every step is idempotent (disable only when not yet disabled,
 * revocations touch live rows only, the address archive skips archived rows).
 *
 * PRIVACY: archiving a customer also withdraws what they exposed or consented
 * to through the linked account (any role): marketing consent is revoked via
 * `unsubscribeEmailFromMarketing` (profile `marketing_opt_in=false` AND the
 * newsletter row unsubscribed directly — the audiences already skip deleted
 * profiles, but `newsletterActive()` reads only the newsletter table, so a
 * still-active row kept mailing an archived customer), and their public
 * favourites page is forced private. Done BEFORE the soft-delete so the
 * `sync-marketing-optin` mirror still sees a live profile.
 */
export const deleteCustomerWorkflow = workflow<
  [z.input<typeof deleteCustomerSchema>, { actorUserId: string }],
  { customerProfileId: string; userId: string | null }
>("customer.delete", async (input, { actorUserId }) => {
  const parsed = deleteCustomerSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  // Read INCLUDING an archived row (`findProfileById` hides it): a retry after a
  // half-finished run must be able to complete the offboarding.
  const [profile] = await db
    .select({ id: customer_profiles.id, deletedAt: customer_profiles.deleted_at })
    .from(customer_profiles)
    .where(eq(customer_profiles.id, parsed.data.customerProfileId))
    .limit(1);
  if (!profile) return fail("not_found", "Client introuvable.");
  const alreadyArchived = profile.deletedAt !== null;

  const link = await customerUserLink.findByProfileId(profile.id);
  const userId = link?.user_id ?? null;

  // Resolve the linked account up front; if we're about to disable a privileged
  // one, enforce the self / escalation / last-admin guards before any write.
  const linkedUser = userId ? await authService.findById(userId) : null;
  // Same self-action refusal as disableUserWorkflow: `assertActorOutranksTarget`
  // lets self through, so without this a customer-enum operator holding
  // customers:delete could archive their own record and disable themselves.
  if (linkedUser && linkedUser.id === actorUserId) {
    return fail("self_action", "Vous ne pouvez pas supprimer votre propre fiche client.");
  }
  // Disable the linked login only when it's a PLAIN customer account (no effective
  // RBAC grant). An internal account (staff/admin — any role grant or allow override)
  // that happens to own a customer profile is left signed-in: its login is managed
  // from the users panel, not here. Same "internal" rule as the derived account type.
  const willDisable = !!linkedUser && !(await isInternalAccount(linkedUser.id));
  if (willDisable) {
    const outranked = await assertActorOutranksTarget(actorUserId, linkedUser!.id);
    if (outranked) return outranked;
    const floor = await assertDisableKeepsAnAdmin(linkedUser!.id);
    if (floor) return floor;
  }

  // 1) Offboard the login FIRST (fail-safe order — see the docblock). Each
  //    audit event is emitted right after its write committed, so the trail
  //    stays exact even if a later step fails.
  let disabledNow = false;
  if (willDisable) {
    disabledNow = !linkedUser!.disabledAt;
    if (disabledNow) await authService.disable(linkedUser!.id);
    const revoked = await authService.deleteSessionsForUser(linkedUser!.id);
    // Same offboarding kill-switch as disableUserWorkflow: even a plain customer
    // account can hold scoped API keys (minted while it briefly held an RBAC role
    // granting `system_api`), and those bearer keys survive account disablement
    // unless revoked here.
    const revokedKeyIds = await apiKeyService.revokeAllForUser(linkedUser!.id);

    if (disabledNow) {
      await bus.emit("user.disabled", { userId: linkedUser!.id, actorUserId }, { actorUserId });
    }
    // A retry over an already-offboarded account revokes nothing — no empty row.
    if (disabledNow || revoked > 0) {
      await bus.emit(
        "user.sessions_revoked",
        { userId: linkedUser!.id, revokedCount: revoked, actorUserId },
        { actorUserId },
      );
    }
    for (const keyId of revokedKeyIds) {
      await bus.emit("api_key.revoked", { keyId, actorUserId }, { actorUserId });
    }
  }

  // 2) Withdraw consent + public exposure (any role) while the profile is live.
  if (linkedUser) {
    // Withdraw marketing consent at the email level — the only key the
    // newsletter table has (idempotent; a no-op when nothing was subscribed).
    await unsubscribeEmailFromMarketing(linkedUser.email, { actorUserId });
    // Take down the /u/<slug> favourites page (pseudonym + products).
    const wishlist = await wishlistService.findByUserId(linkedUser.id);
    if (wishlist?.is_public) await wishlistService.forcePrivate(wishlist.id);
  }

  // 3) Archive LAST. Cascade to the addresses first so their PII (street / city
  //    / phone) isn't left live/queryable (mirrors PrestaShop); the profile row
  //    goes last so any failure above keeps the run retryable. An already
  //    archived profile keeps its original deleted_at.
  await customerService.softDeleteAddressesByProfile(profile.id);
  if (!alreadyArchived) await customerService.softDeleteProfile(profile.id);

  // One customer.deleted per archive — re-emitted on an already-archived
  // profile only when this run finished its offboarding (the pre-fix order
  // archived first and could die before emitting it).
  if (!alreadyArchived || disabledNow) {
    await bus.emit(
      "customer.deleted",
      { customerProfileId: profile.id, userId },
      { actorUserId },
    );
  }

  return ok({ customerProfileId: profile.id, userId });
});
