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
 * When a shopper joins the newsletter we look up a live promotion whose code
 * is configured by the `newsletter.welcome_code` site setting (case-insensitive,
 * trigger_kind=code), falling back to `WELCOME10` when the setting is unset.
 * If a matching live promotion exists we email it to them; otherwise we no-op
 * silently — the subscriber is best-effort and never fails the subscription
 * action.
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

/** Setting key for the welcome-coupon promo code, with a hardcoded fallback. */
const WELCOME_CODE_SETTING_KEY = "newsletter.welcome_code";
const WELCOME_CODE_FALLBACK = "WELCOME10";

export function registerWelcomeCouponSubscriber() {
  bus.on("newsletter.subscribed", async ({ payload }) => {
    if (payload.reactivated) return;
    if (payload.source === "account") return;

    try {
      if (!(await isFlowEnabled("newsletter_coupon"))) return;
      const settings = await getSettingsMap();
      const welcomeCode =
        settings[WELCOME_CODE_SETTING_KEY]?.trim() || WELCOME_CODE_FALLBACK;
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
