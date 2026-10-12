import "server-only";

import { cache } from "react";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { parseCents, parseBool, trimOrNull } from "./parse";

/**
 * Storefront-facing checkout copy resolver.
 *
 * Centralises the strings + numbers that drive shipping / returns /
 * warranty messaging across the PDP "Livraison" tab, the cart sidebar
 * trust strip, and the checkout trust strip. Reads the same
 * `checkout.delivery.*` setting keys the `/admin/system/checkout` page
 * writes, so the operator can tune copy + thresholds without a deploy.
 *
 * Content policy: the TEXT labels carry NO default. An unset / cleared
 * label resolves to `null` and every surface that renders it hides that
 * line/badge — we never assert a delivery, returns or warranty claim the
 * operator hasn't explicitly entered. Only the NUMERIC shipping config
 * (free-shipping threshold + flat fee) keeps a functional fallback, because
 * that is cart LOGIC (the math can't be NaN), not display content.
 *
 * Cached with React.cache so all callers in a single render (e.g. the
 * checkout page reads it once for shipping calc + once for the trust
 * strip) share one DB hit. The underlying `getSettingsMap` already
 * tolerates a missing settings table — we still wrap in try/catch here so
 * the storefront never crashes on a cold DB.
 */

// Numeric shipping config keeps a functional fallback — a free-shipping
// threshold / flat fee is store LOGIC (the cart total can't be NaN), not
// display "content".
// Minor units = millimes (1/1000 TND). See src/lib/price.ts (MINOR_PER_DINAR).
const DEFAULT_FREE_THRESHOLD_CENTS = 250_000; // 250 TND
const DEFAULT_FEE_CENTS = 7_000; // 7 TND

// Delivery-window defaults (domestic TN) — drive the PDP Offer JSON-LD
// `deliveryTime` (handling + transit). These are DAY counts, not money. Like the
// shipping fee they keep a functional fallback (Google needs a valid window),
// rather than being null-when-unset "content".
const DEFAULT_HANDLING_DAYS_MIN = 1;
const DEFAULT_HANDLING_DAYS_MAX = 3;
const DEFAULT_TRANSIT_DAYS_MIN = 2;
const DEFAULT_TRANSIT_DAYS_MAX = 5;

export type CheckoutCopy = {
  /** Master switch for the free-shipping THRESHOLD offer (home delivery).
   *  Default true. When false, the shipping resolvers treat the threshold as 0
   *  ("never free") so the home-delivery fee is always charged and the cart
   *  hides the "Plus que X…" nudge. Independent of member/B2B and promo
   *  free-shipping, which are separate features. */
  freeShippingEnabled: boolean;
  /** Cents — subtotal at/above this is free shipping. `null` when admin
   *  cleared the field (caller falls back to the numeric constant for the
   *  shipping math). NB: gated by `freeShippingEnabled` in the resolvers; this
   *  field always carries the RAW configured value (for admin display). */
  freeThresholdCents: number | null;
  /** Cents — flat shipping fee below the threshold. `null` when admin
   *  cleared the field. */
  defaultFeeCents: number | null;
  /** Days — order handling window MIN for the PDP Offer `deliveryTime`.
   *  `null` when cleared (caller falls back to the numeric constant). */
  handlingDaysMin: number | null;
  /** Days — order handling window MAX. `null` ⇒ caller falls back. */
  handlingDaysMax: number | null;
  /** Days — carrier transit window MIN. `null` ⇒ caller falls back. */
  transitDaysMin: number | null;
  /** Days — carrier transit window MAX. `null` ⇒ caller falls back. */
  transitDaysMax: number | null;
  /** Short delivery-ETA string. `null` ⇒ the operator hasn't set it, so
   *  every surface hides the line/badge (no fabricated default). */
  etaLabel: string | null;
  /** Returns trust-strip + PDP copy. `null` ⇒ hidden. */
  returnsLabel: string | null;
  /** Returns-conditions bullet on the PDP "Livraison" tab. `null` ⇒ hidden. */
  returnsConditionsLabel: string | null;
  /** Refund-window bullet on the PDP "Livraison" tab. `null` ⇒ hidden. */
  refundLabel: string | null;
  /** Optional Click & Collect bullet. `null` ⇒ hidden. */
  clickCollectLabel: string | null;
  /** Warranty trust-strip copy. `null` ⇒ hidden. */
  warrantyLabel: string | null;
};

export const getCheckoutCopy = cache(async (): Promise<CheckoutCopy> => {
  let settings: Record<string, string | null> = {};
  try {
    settings = await getSettingsMap();
  } catch {
    // Settings table unavailable (boot order on a fresh DB) — every text
    // label resolves to null (hidden), the numeric callers fall back to the
    // constants below. The storefront still renders without fabricated copy.
  }
  return {
    // Default true — existing stores keep their free-shipping offer until the
    // operator explicitly disables it on the Livraison page.
    freeShippingEnabled: parseBool(settings["delivery.free_shipping_enabled"], true),
    freeThresholdCents: parseCents(settings["checkout.delivery.free_threshold_cents"]),
    defaultFeeCents: parseCents(settings["checkout.delivery.default_fee_cents"]),
    // Day counts (NOT money) — parseCents handles non-negative integers; null
    // when cleared, the JSON-LD caller falls back to CHECKOUT_COPY_FALLBACKS.
    handlingDaysMin: parseCents(settings["checkout.delivery.handling_days_min"]),
    handlingDaysMax: parseCents(settings["checkout.delivery.handling_days_max"]),
    transitDaysMin: parseCents(settings["checkout.delivery.transit_days_min"]),
    transitDaysMax: parseCents(settings["checkout.delivery.transit_days_max"]),
    // No text defaults — an unset label stays null and the UI hides it.
    etaLabel: trimOrNull(settings["checkout.delivery.eta_label"]),
    returnsLabel: trimOrNull(settings["checkout.returns.label"]),
    returnsConditionsLabel: trimOrNull(settings["checkout.returns.conditions_label"]),
    refundLabel: trimOrNull(settings["checkout.returns.refund_label"]),
    clickCollectLabel: trimOrNull(settings["checkout.delivery.click_collect_label"]),
    warrantyLabel: trimOrNull(settings["checkout.warranty.label"]),
  };
});

/**
 * NUMERIC fallback for shipping math (e.g. `previewShipping`) when the admin
 * hasn't set a threshold / fee. Text labels are intentionally null — there is
 * no "legacy default copy" anymore; an unconfigured label renders nothing.
 */
export const CHECKOUT_COPY_FALLBACKS = {
  freeShippingEnabled: true,
  freeThresholdCents: DEFAULT_FREE_THRESHOLD_CENTS,
  defaultFeeCents: DEFAULT_FEE_CENTS,
  handlingDaysMin: DEFAULT_HANDLING_DAYS_MIN,
  handlingDaysMax: DEFAULT_HANDLING_DAYS_MAX,
  transitDaysMin: DEFAULT_TRANSIT_DAYS_MIN,
  transitDaysMax: DEFAULT_TRANSIT_DAYS_MAX,
  etaLabel: null,
  returnsLabel: null,
  returnsConditionsLabel: null,
  refundLabel: null,
  clickCollectLabel: null,
  warrantyLabel: null,
} as const;
