import "server-only";

import { dispatchEmail, isFlowEnabled } from "@/modules/mailing";
import { promotionService } from "@/modules/promotion";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { describePromoDiscount } from "@/lib/mailing/promo-describe";
import { bus } from "../bus";

/**
 * Welcome-coupon subscriber for `newsletter.subscribed`.
 *
 * When a shopper joins the newsletter we look up a live promotion whose code the
 * operator configured in the `newsletter.welcome_code` site setting (case-
 * insensitive, trigger_kind=code). If the setting is UNSET we send nothing — there
 * is NO hardcoded fallback code (advertising a code the operator never chose, which
 * may map to an unrelated promo or to nothing, is a fabrication). If the setting
 * names a code but no matching LIVE promotion exists, we also no-op. Best-effort —
 * never fails the subscription action.
 *
 * The admin still creates / edits the actual promotion through the normal
 * /admin/promotions surface; this setting only chooses WHICH code we look up.
 * The `newsletter.welcome_code` value is editable in the Mailing admin hub
 * (Automations/Réglages tab) — see `src/lib/actions/mailing.ts`.
 *
 * Re-subscriptions (newsletter.subscribed with `reactivated:true`) are
 * skipped — the email landed once already on first signup. So are
 * `source: "account"` events: those mirror the customer's own marketing-consent
 * toggle onto the newsletter row (`sync-marketing-optin`, incl. the signup
 * opt-in) — an account opt-in is not a newsletter-form signup, and never got
 * the coupon.
 */

/** Setting key for the welcome-coupon promo code. Unset ⇒ no welcome coupon sent. */
const WELCOME_CODE_SETTING_KEY = "newsletter.welcome_code";

export function registerWelcomeCouponSubscriber() {
  bus.on("newsletter.subscribed", async ({ payload }) => {
    if (payload.reactivated) return;
    if (payload.source === "account") return;

    try {
      if (!(await isFlowEnabled("newsletter_coupon"))) return;
      const settings = await getSettingsMap();
      const welcomeCode = settings[WELCOME_CODE_SETTING_KEY]?.trim();
      // No fabricated fallback: only send a welcome coupon when the operator has
      // explicitly configured a code (and only if it maps to a LIVE promotion).
      if (!welcomeCode) return;
      const promo = await promotionService.findLiveByCode(welcomeCode);
      if (!promo || !promo.code) return;

      // « −10 % » / « −5 TND » / « Livraison offerte » (never « 0% » for a
      // free-delivery welcome code).
      const discount = describePromoDiscount(promo);

      // Routed through the central dispatcher → the "newsletter_coupon"
      // template (admin-editable + toggleable in the Mailing tab).
      await dispatchEmail({
        key: "newsletter_coupon",
        to: payload.email,
        flowKey: "newsletter_coupon",
        variables: {
          code: promo.code.toUpperCase(),
          discount,
          shop_url: await resolvePublicOrigin(),
        },
      });
    } catch (err) {
      // Best-effort — never crash the subscription on a mail failure.
      console.error("[events] send-welcome-coupon failed", err);
    }
  });
}
