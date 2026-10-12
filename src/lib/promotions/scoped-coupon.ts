/**
 * Pure helpers for SCOPED coupon codes — a code/URL coupon whose scope is a
 * product / category / brand (not the whole cart). Such a coupon discounts only
 * the cart lines matching its scope; this file computes that matching-lines base
 * given a pre-resolved match set. The DB-backed matcher that turns a scope into
 * the set of matching product ids lives in `@/modules/promotion` queries
 * (`productsMatchingScope`) so this stays db-free and unit-testable.
 *
 * Design: a scoped coupon's discount is still applied as a single ORDER-LEVEL
 * reduction (the same `coupon_discount` path cart-scope coupons use) — only the
 * BASE it is computed on changes (matching lines instead of the whole subtotal).
 * That reuses the entire redemption / refund / member-stacking pipeline already
 * built for cart coupons, instead of baking per-line prices like an auto promo.
 */

/** One cart line, reduced to what the scoped-coupon base needs. */
export type CouponCartLine = {
  productId: string;
  /** Charged subtotal for the line (qty-multiplied, AFTER any auto-promo). */
  lineCents: number;
  /** Catalogue subtotal (qty-multiplied, pre auto-promo). A line is "on sale"
   *  when `lineCents < baseLineCents`. Equal to `lineCents` when not discounted. */
  baseLineCents: number;
};

/**
 * Sum the charged subtotal of the lines whose product is in `matchingProductIds`.
 * When `excludeDiscounted` is true, lines already cut by an auto-promo
 * (`lineCents < baseLineCents`) are skipped — the scoped analogue of a cart
 * coupon's `exclude_discounted_items` (don't stack a code on already-on-sale
 * items). Returns 0 when nothing matches (caller drops the coupon).
 */
export function scopedCouponBaseCents(
  lines: readonly CouponCartLine[],
  matchingProductIds: ReadonlySet<string>,
  excludeDiscounted: boolean,
): number {
  let base = 0;
  for (const l of lines) {
    if (!matchingProductIds.has(l.productId)) continue;
    if (excludeDiscounted && l.lineCents < l.baseLineCents) continue;
    base += l.lineCents;
  }
  return base;
}
