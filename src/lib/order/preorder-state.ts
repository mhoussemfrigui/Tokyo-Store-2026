/**
 * Order-side précommande (preorder) state helpers — pure.
 *
 * A preorder ORDER (`orders.is_preorder`) was placed with ≥1 active-preorder line;
 * those lines claim NO stock at placement (they reserve units instead) and are
 * flipped at CONVERSION (`orders.preorder_converted_at`), when the product releases
 * and the lines decrement stock for real. See `@/lib/inventory/preorder`.
 */

/** Still a reservation (placed as a preorder, not yet converted). */
export function isPreorderReserved(o: {
  is_preorder: boolean;
  preorder_converted_at: Date | null;
}): boolean {
  return o.is_preorder && o.preorder_converted_at == null;
}

/** Converted: the preorder released and its lines decremented stock for real. */
export function isPreorderConverted(o: {
  is_preorder: boolean;
  preorder_converted_at: Date | null;
}): boolean {
  return o.is_preorder && o.preorder_converted_at != null;
}

/**
 * Whether a line's stock has ACTUALLY been decremented — a regular line (claimed
 * at placement in Tokyo) or a CONVERTED preorder line. The cancel / refund restock
 * gate reads THIS, never `is_preorder`, so a never-decremented preorder line is
 * never restocked (`order_items.stock_claimed` is NOT NULL DEFAULT true, so only an
 * explicit `false` — an open preorder line — reads as not-decremented).
 */
export function lineWasDecremented(line: { stock_claimed?: boolean | null }): boolean {
  return line.stock_claimed !== false;
}
