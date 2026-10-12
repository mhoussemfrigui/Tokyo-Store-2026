/**
 * Pure promotion discount helper.
 *
 * `discountPercent` computes the "% off" badge value used on product cards and
 * the PDP buy-block. (The cart/per-line discount maths live inline at their
 * call sites — `src/lib/cart/coupon.ts` and `src/workflows/promotion/redeem.ts`.)
 */

/**
 * "% off" badge value from a current price and its old (struck-through) price.
 *
 * Guarded so a missing / non-positive / non-discounted old price yields 0:
 *   oldPriceMinor > priceMinor > 0  →  Math.round(((old - price) / old) * 100)
 * otherwise 0.
 */
export function discountPercent(
  priceMinor: number,
  oldPriceMinor: number,
): number {
  return oldPriceMinor > priceMinor && priceMinor > 0
    ? Math.round(((oldPriceMinor - priceMinor) / oldPriceMinor) * 100)
    : 0;
}
