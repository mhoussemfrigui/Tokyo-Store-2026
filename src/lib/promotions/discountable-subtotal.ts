/**
 * The "discountable subtotal" a cart-scope coupon with `exclude_discounted_items`
 * applies to: the sum of line subtotals that are NOT already discounted by an
 * auto product/category/brand promo. A line counts as discounted when its current
 * effective unit price is BELOW its base (catalogue) unit price — those lines are
 * excluded from the coupon base (WooCommerce `exclude_sale_items` semantics).
 *
 * Pure (no DB / no server-only) so both the cart resolver and place-order compute
 * it identically and it is unit-testable. `unitCents` is the live/charged unit
 * price; `baseCents` is the catalogue base. Non-finite/missing → treated as not
 * discounted (counts toward the base) so a data gap never silently inflates the
 * discount.
 */
export function discountableSubtotalCents(
  lines: ReadonlyArray<{
    unitCents: number;
    baseCents: number;
    quantity: number;
  }>,
): number {
  let sum = 0;
  for (const l of lines) {
    const unit = Number.isFinite(l.unitCents) ? l.unitCents : 0;
    const base = Number.isFinite(l.baseCents) ? l.baseCents : unit;
    const qty = Number.isFinite(l.quantity) ? l.quantity : 0;
    // Discounted (unit < base) → excluded. Not-on-sale (unit >= base) → included.
    if (unit >= base) sum += unit * qty;
  }
  return sum;
}
