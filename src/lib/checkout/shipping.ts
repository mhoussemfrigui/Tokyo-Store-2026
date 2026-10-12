import "server-only";

import { getCheckoutCopy, CHECKOUT_COPY_FALLBACKS } from "./copy";

/**
 * Shipping fee preview for /panier and /checkout.
 *
 * Brand promise (also surfaced in marketing copy): "Livraison gratuite dès
 * 250 TND". Below that threshold the customer pays a flat 7 TND for standard
 * delivery. Both values are admin-configurable via
 * `/admin/system/checkout` (keys: `checkout.delivery.free_threshold_cents`,
 * `checkout.delivery.default_fee_cents`) — `getCheckoutCopy` reads them
 * here. When a setting is unset, we fall back to the built-in constants
 * (`CHECKOUT_COPY_FALLBACKS`) so the storefront keeps its brand promise on
 * a fresh deploy.
 *
 * The order workflow (`placeOrderWorkflow`) re-computes the authoritative
 * `shipping_cents` server-side so this helper is presentation only —
 * never the source of truth.
 *
 * Values are integer millimes (1/1000 TND), matching the `unit_price_cents` /
 * `subtotal_cents` columns on the orders table. The `*_cents` column names are
 * legacy — they hold millimes, not centimes (see src/lib/price.ts).
 */

export type ShippingPreview = {
  /** What to charge in cents (0 when subtotal qualifies for free shipping). */
  shippingCents: number;
  /** True when subtotal ≥ threshold — UI shows "Offerte" badge. */
  isFree: boolean;
  /** Threshold in cents — UI can render "Plus que X TND pour la livraison gratuite". */
  freeThresholdCents: number;
  /** Remaining cents to unlock free shipping (0 when already free). */
  cartsAwayFromFreeCents: number;
};

/**
 * The storefront's home-delivery shipping config in major-unit dinars, for the
 * NEW Tokyo storefront to DISPLAY the same flat fee + free-shipping threshold the
 * order is CHARGED. `previewShipping(0)` yields the flat fee (subtotal 0 never
 * qualifies for free) and the effective threshold (0 when free shipping is off),
 * both read from the admin-configured `checkout.delivery.*` settings — the exact
 * numbers `resolveDelivery`'s home base uses. Read server-side (RSC/layout) so the
 * values are correct in the server render / for crawlers, not a client default.
 * `freeFrom === 0` ⇒ "no free-shipping offer".
 */
export async function getStorefrontShippingConfig(): Promise<{ fee: number; freeFrom: number }> {
  const p = await previewShipping(0);
  return { fee: p.shippingCents / 1000, freeFrom: p.freeThresholdCents / 1000 };
}

export async function previewShipping(subtotalCents: number): Promise<ShippingPreview> {
  const copy = await getCheckoutCopy();
  // Free-shipping disabled ⇒ threshold 0 ("never free"): the flat fee is always
  // charged and `cartsAwayFromFreeCents` is 0 (the cart hides the nudge). Kept
  // identical to `getHomeBaseRate` so the preview and the authoritative
  // order-time charge never disagree.
  const freeThresholdCents = copy.freeShippingEnabled
    ? copy.freeThresholdCents ?? CHECKOUT_COPY_FALLBACKS.freeThresholdCents
    : 0;
  const flatRateCents =
    copy.defaultFeeCents ?? CHECKOUT_COPY_FALLBACKS.defaultFeeCents;
  // Threshold 0 = "no free-shipping offer" — consistent with `homeFeeFor` and
  // the per-agent sentinel. "Always free" is expressed via a 0 flat rate, not a
  // 0 threshold, so the preview never promises free shipping the order then charges.
  const isFree = freeThresholdCents > 0 && subtotalCents >= freeThresholdCents;
  return {
    shippingCents: isFree ? 0 : flatRateCents,
    isFree,
    freeThresholdCents,
    cartsAwayFromFreeCents: isFree
      ? 0
      : Math.max(0, freeThresholdCents - subtotalCents),
  };
}
