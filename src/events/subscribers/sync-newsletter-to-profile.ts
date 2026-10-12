import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { users } from "@/modules/auth/schema";
import { customer_profiles } from "@/modules/customer/schema";
import { customer_user_links } from "@/associations/customer-user";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { bus } from "../bus";

/**
 * Forward-sync a newsletter (re)subscribe → the customer profile's marketing
 * consent.
 *
 * A logged-in customer who turned marketing OFF at the profile level and then
 * re-subscribes via the footer would otherwise stay silently un-mailable:
 * `canSendMarketingTo` short-circuits on the profile opt-in BEFORE it ever
 * checks the newsletter row. So treat an explicit (re)subscribe BY THAT
 * CUSTOMER as FRESH consent — flip the linked profile's `marketing_opt_in` back
 * ON and emit `customer.profile_updated` (so the existing `sync-marketing-optin`
 * mirror runs and the change is audit-logged).
 *
 * Consent gate: the public footer form is unauthenticated and the address is
 * never verified, so a bare email proves nothing — anyone could type a
 * customer's address and undo their opt-out. The flip therefore happens only
 * when the event's actor IS the linked account (signed in, subscribing their
 * own email), or when a staff member holding `newsletter:manage` re-subscribed
 * the address from the admin (`source: "admin"`, behind a consent-stating
 * confirmation). Anonymous / other-account subscribes only re-activate the
 * newsletter row; the profile opt-out keeps winning in the consent gate.
 *
 * This is the deliberate, narrow counterpart to the "reverse sync intentionally
 * not shipped" note in `sync-marketing-optin.ts`: we only ACT on an explicit
 * subscribe (a consent signal), never on an unsubscribe, keeping the data flow
 * unambiguous. No-op when there's no linked profile (newsletter-only address) or
 * the profile is already opted-in. Best-effort — a failure never breaks subscribe.
 *
 * Loop-safe: the emitted `customer.profile_updated` makes `sync-marketing-optin`
 * look up the newsletter row, which is already active → a no-op (no re-emit).
 */
export function registerNewsletterToProfileSyncSubscriber() {
  bus.on("newsletter.subscribed", async ({ payload, actorUserId }) => {
    try {
      const email = payload.email.trim().toLowerCase();
      if (!email) return;
      if (!actorUserId) return; // anonymous subscribe — never a consent signal for an account
      // `source: "account"` is `sync-marketing-optin` MIRRORING the profile's own
      // consent onto the newsletter row — never loop it back into the profile
      // (a stale mirror could otherwise re-opt-in a profile that was just opted out).
      if (payload.source === "account") return;

      const [row] = await db
        .select({
          pid: customer_profiles.id,
          userId: users.id,
          optIn: customer_profiles.marketing_opt_in,
        })
        .from(users)
        .innerJoin(customer_user_links, eq(customer_user_links.user_id, users.id))
        .innerJoin(customer_profiles, eq(customer_profiles.id, customer_user_links.customer_profile_id))
        .where(sql`lower(${users.email}) = ${email}`)
        .limit(1);

      if (!row || row.optIn) return; // newsletter-only address, or already opted-in

      const isOwner = actorUserId === row.userId;
      const isStaffOverride =
        !isOwner &&
        payload.source === "admin" &&
        permissionSetAllows(await resolveUserPermissions(actorUserId), "newsletter", "manage");
      if (!isOwner && !isStaffOverride) return;

      await db
        .update(customer_profiles)
        .set({ marketing_opt_in: true, updated_at: sql`now()` })
        .where(eq(customer_profiles.id, row.pid));

      await bus
        .emit(
          "customer.profile_updated",
          { userId: row.userId, customerProfileId: row.pid, changedFields: ["marketing_opt_in"] },
          { actorUserId },
        )
        .catch(() => {});
    } catch (err) {
      console.error("[events] sync-newsletter-to-profile failed", err);
    }
  });
}
