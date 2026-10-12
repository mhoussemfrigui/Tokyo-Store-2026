import { formatMoneyExact } from "@/lib/price";

/**
 * The customer-facing BENEFIT label of a promotion, for the marketing emails that
 * advertise a code (welcome coupon, birthday gift, promotion announcement) — the
 * `{{ discount }}` variable of their templates.
 *
 *   percent 10            → « −10 % »
 *   fixed 5000 (millimes) → « −5 TND »
 *   free-shipping only    → « Livraison offerte »  (discount_value = 0, allowed
 *                            by the promotions CHECK when grants_free_shipping)
 *   discount + shipping   → « −10 % + livraison offerte »
 *
 * One helper so the three senders can't drift, and so a free-delivery code never
 * reads « 0% de réduction » / « 0 TND ». Same notation as the admin auto-name
 * (`buildAutoPromoName`). Pure + client-safe (unit-tested).
 */
export function describePromoDiscount(promo: {
  discount_type: "percent" | "fixed";
  /** Percent (1-100) or millimes off; 0 only for a free-shipping-only promo. */
  discount_value: number;
  grants_free_shipping: boolean;
}): string {
  const value = promo.discount_value > 0 ? promo.discount_value : 0;
  const amount =
    value === 0
      ? null
      : promo.discount_type === "percent"
        ? `−${value} %`
        : `−${formatMoneyExact(value)}`;
  if (!amount) return promo.grants_free_shipping ? "Livraison offerte" : "Offre spéciale";
  return promo.grants_free_shipping ? `${amount} + livraison offerte` : amount;
}
