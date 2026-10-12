import "server-only";

import { z } from "zod";

import { authService } from "@/modules/auth/service";
import { apiKeyService } from "@/modules/api-key/service";
import { assertActorOutranksTarget, assertDisableKeepsAnAdmin } from "@/lib/rbac/guards";
import { bus } from "@/events/bus";
import { unsubscribeEmailFromMarketing } from "@/workflows/customer/unsubscribe";
import { fail, ok, workflow } from "../shared";

/**
 * Admin-only user disable. Sets `disabledAt`, revokes every active session
 * so the user can't keep acting on their cached cookie, revokes any API keys the
 * user created (bearer keys bypass the login ban, so disablement wouldn't stop
 * them otherwise), withdraws marketing consent (profile opt-in + newsletter row —
 * the opt-in audiences don't read `disabled_at`, so a banned account kept
 * receiving campaigns), and emits the audit events. Re-enable via `enableUser`
 * (which does NOT un-revoke keys — an offboarded key stays dead — nor re-subscribe:
 * the user opts back in themselves). A public favourites page needs no write
 * here: `findPublicBySlug` already hides a disabled owner's list, and it
 * reappears on re-enable.
 */
export const disableUserSchema = z.object({ userId: z.string().min(1) });

export const disableUserWorkflow = workflow<
  [z.input<typeof disableUserSchema>, { actorUserId: string }],
  { userId: string }
>("auth.disable_user", async (input, { actorUserId }) => {
  const parsed = disableUserSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const existing = await authService.findById(parsed.data.userId);
  if (!existing) return fail("not_found", "Utilisateur introuvable.");
  if (existing.id === actorUserId) {
    return fail("self_action", "Vous ne pouvez pas vous désactiver vous-même.");
  }
  // A non-wildcard actor may not disable a higher-privileged target.
  const outranked = await assertActorOutranksTarget(actorUserId, existing.id);
  if (outranked) return outranked;
  // LAST-ADMIN FLOOR. Access is role-only now: `*` comes solely from a role grant
  // (an account can hold it while also owning a customer profile, since the role
  // editor reaches customer-360 accounts), so disabling the last effective `*`
  // holder would lock everyone out. assertDisableKeepsAnAdmin counts role-granted
  // `*` holders (excluding deny-override phantoms) and refuses only when no OTHER
  // active one remains.
  const floor = await assertDisableKeepsAnAdmin(existing.id);
  if (floor) return floor;
  await authService.disable(existing.id);
  const revoked = await authService.deleteSessionsForUser(existing.id);
  // Kill the user's standing bearer credentials too — they authenticate on the
  // key hash + scopes alone and never traverse the login ban, so without this a
  // disabled/offboarded user keeps a live write credential.
  const revokedKeyIds = await apiKeyService.revokeAllForUser(existing.id);

  await bus.emit("user.disabled", { userId: existing.id, actorUserId }, { actorUserId });
  await bus.emit(
    "user.sessions_revoked",
    { userId: existing.id, revokedCount: revoked, actorUserId },
    { actorUserId },
  );
  // Audit each revoked key (the wildcard subscriber logs it; also surfaces on the
  // Sécurité page's API-key trail).
  for (const keyId of revokedKeyIds) {
    await bus.emit("api_key.revoked", { keyId, actorUserId }, { actorUserId });
  }

  // A banned account stops receiving marketing (idempotent; no-op when the
  // address was never subscribed / opted in). LAST and BEST-EFFORT: the disable,
  // the revocations and their audit rows above are already done and must never
  // be reported as failed because of this side-effect.
  await unsubscribeEmailFromMarketing(existing.email, { actorUserId }).catch((err) =>
    console.error("[disable-user] marketing withdrawal failed", err),
  );

  return ok({ userId: existing.id });
});

export const enableUserWorkflow = workflow<
  [z.input<typeof disableUserSchema>, { actorUserId: string }],
  { userId: string }
>("auth.enable_user", async (input, { actorUserId }) => {
  const parsed = disableUserSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const existing = await authService.findById(parsed.data.userId);
  if (!existing) return fail("not_found", "Utilisateur introuvable.");

  // A non-wildcard actor may not RE-ENABLE a higher-privileged target either
  // (the guard reads the target's LATENT privilege, ignoring the disabled flag,
  // so a delegate can't restore a disabled super_admin's '*').
  const outranked = await assertActorOutranksTarget(actorUserId, existing.id);
  if (outranked) return outranked;

  await authService.enable(existing.id);
  await bus.emit("user.enabled", { userId: existing.id, actorUserId }, { actorUserId });
  return ok({ userId: existing.id });
});

export const forceLogoutWorkflow = workflow<
  [z.input<typeof disableUserSchema>, { actorUserId: string }],
  { userId: string; revokedCount: number }
>("auth.force_logout", async (input, { actorUserId }) => {
  const parsed = disableUserSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const existing = await authService.findById(parsed.data.userId);
  if (!existing) return fail("not_found", "Utilisateur introuvable.");

  // A non-wildcard actor may not force-logout a higher-privileged target.
  const outranked = await assertActorOutranksTarget(actorUserId, existing.id);
  if (outranked) return outranked;

  const revoked = await authService.deleteSessionsForUser(existing.id);

  await bus.emit(
    "user.sessions_revoked",
    { userId: existing.id, revokedCount: revoked, actorUserId },
    { actorUserId },
  );

  return ok({ userId: existing.id, revokedCount: revoked });
});

/**
 * Admin-side toggle of `email_verified`. Used when an admin has out-of-band
 * confirmation (e.g. customer phoned in) and wants to bypass the email
 * round-trip — or to revert a wrongful auto-verification. The
 * `user.email_verified` event only fires when flipping ON, matching the
 * semantics of the public verify flow.
 */
export const setEmailVerifiedSchema = z.object({
  userId: z.string().min(1),
  verified: z.boolean(),
});

export const setEmailVerifiedWorkflow = workflow<
  [z.input<typeof setEmailVerifiedSchema>, { actorUserId: string }],
  { userId: string; verified: boolean }
>("auth.set_email_verified", async (input, { actorUserId }) => {
  const parsed = setEmailVerifiedSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const existing = await authService.findById(parsed.data.userId);
  if (!existing) return fail("not_found", "Utilisateur introuvable.");

  // A non-wildcard actor may not flip the verification flag of a higher target.
  const outranked = await assertActorOutranksTarget(actorUserId, existing.id);
  if (outranked) return outranked;

  // No-op guard: if the flag already holds the requested value, don't write or
  // emit. Keeps the audit trail meaningful (one row = one real state change) and
  // stops a repeated click from spamming the override event.
  if (existing.emailVerified === parsed.data.verified) {
    return ok({ userId: existing.id, verified: parsed.data.verified });
  }

  await authService.update(existing.id, { emailVerified: parsed.data.verified });

  // ALWAYS audit the admin override prominently (warn, both directions). Flipping
  // `email_verified` ON without the user proving mailbox ownership is an
  // account-takeover-enabling action (an admin-compromise vector: verify a
  // squatted email, then password-reset to the attacker mailbox). The dedicated
  // event makes it stand out on the Sécurité page vs. the routine verify flow.
  await bus.emit(
    "user.email_verified_admin_override",
    {
      userId: existing.id,
      email: existing.email,
      verified: parsed.data.verified,
      actorUserId,
    },
    { actorUserId },
  );

  if (parsed.data.verified) {
    await bus.emit(
      "user.email_verified",
      { userId: existing.id, email: existing.email },
      { actorUserId },
    );
  }

  return ok({ userId: existing.id, verified: parsed.data.verified });
});
