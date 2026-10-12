import "server-only";

import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { newsletterService } from "@/modules/newsletter/service";
import { bus } from "../bus";

/**
 * Sync `customer_profiles.marketing_opt_in` ↔ `newsletter_subscriptions`.
 *
 * One source of truth for marketing consent: when an admin or the
 * customer themselves flips the opt-in toggle on their profile, we
 * mirror it to the newsletter table:
 *   - opt-in TRUE  + no live sub for that email → insert one (source: account)
 *   - opt-in TRUE  + soft-unsub'd row exists    → reactivate
 *   - opt-in FALSE + live sub exists            → soft unsubscribe
 *
 * After each write it emits the matching newsletter event — `newsletter.subscribed`
 * `{ source: "account", reactivated }` / `newsletter.unsubscribed` `{ source:
 * "account" }` — with the profile edit's actor, so an opt-in/opt-out made from the
 * account page, at signup or by an admin on the customer profile reaches the
 * audit trail (« Désinscription marketing ») and newsletter-domain webhooks like a
 * footer/token one. `source: "account"` marks the event as a MIRROR of the
 * profile consent: the welcome-coupon mailer ignores it (an account opt-in is
 * not a newsletter signup).
 *
 * Loop safety: this subscriber only listens to `customer.profile_updated` — it
 * does NOT watch `newsletter.subscribed`. The opposite direction is handled,
 * narrowly, by `sync-newsletter-to-profile.ts`, which acts ONLY on an explicit
 * (re)subscribe and IGNORES `source: "account"` (the event it would react to is
 * this very mirror — and the profile is already opted in anyway). Neither
 * subscriber reacts to a newsletter *unsubscribe*, so the two can't ping-pong.
 *
 * We only act when the change set actually includes `marketing_opt_in`
 * so a name / phone edit doesn't trigger an opt-in lookup it wouldn't
 * have changed anyway.
 *
 * Best-effort: any failure (missing user, mail provider down, race with
 * a concurrent newsletter write) logs and swallows — the profile write
 * already committed.
 */

export function registerMarketingOptInSyncSubscriber() {
  bus.on("customer.profile_updated", async ({ payload, actorUserId }) => {
    if (!payload.changedFields.includes("marketing_opt_in")) return;
    if (!payload.userId) return; // unlinked / guest profile — no account to mirror to

    try {
      const profile = await customerService.findProfileById(payload.customerProfileId);
      if (!profile) return;

      // Find the linked user's email — the email on the user row is the
      // canonical address for marketing; the customer profile doesn't
      // store one separately.
      const user = await authService.findById(payload.userId);
      const email = user?.email?.trim().toLowerCase();
      if (!email) return;

      const meta = { actorUserId: actorUserId ?? null };
      if (profile.marketing_opt_in) {
        const existing = await newsletterService.findByEmail(email);
        if (!existing) {
          await newsletterService.insert({
            email,
            source: "account",
          });
          await bus
            .emit("newsletter.subscribed", { email, source: "account", reactivated: false }, meta)
            .catch(() => {});
        } else if (existing.unsubscribed_at) {
          await newsletterService.reactivate(existing.id);
          await bus
            .emit("newsletter.subscribed", { email, source: "account", reactivated: true }, meta)
            .catch(() => {});
        }
      } else {
        const existing = await newsletterService.findByEmail(email);
        if (existing && !existing.unsubscribed_at) {
          await newsletterService.unsubscribe(existing.id);
          await bus
            .emit("newsletter.unsubscribed", { email, source: "account" }, meta)
            .catch(() => {});
        }
      }
    } catch (err) {
      console.error("[events] sync-marketing-optin failed", err);
    }
  });
}
