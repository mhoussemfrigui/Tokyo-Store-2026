/**
 * The ONE `in_stock` re-derivation rule shared by every stock writer that changes
 * a QUANTITY without the operator/caller setting the availability flag
 * explicitly — PURE (no server-only deps), so it's unit-testable in isolation.
 *
 * `in_stock` carries two meanings: "sold out" (a sale emptied the line) and
 * "deliberately delisted" (the operator unticked Disponible on a line that still
 * has units). A quantity write must only undo the FIRST:
 *
 *   - line was SOLD OUT (tracked, old qty ≤ 0) → re-listed iff the new qty > 0
 *     (a restock makes it sellable again; a still-empty line stays off);
 *   - line was UNTRACKED (old qty NULL) and starts being tracked → listed iff the
 *     new qty > 0. On an untracked line unticking « En stock » is the ONLY way to
 *     say « Rupture de stock » (there is no quantity to reach 0), so a first
 *     quantity > 0 — an ERP/WMS sync, the editor, a first per-location level — is
 *     a restock, exactly as the product-form helper promises;
 *   - otherwise (in stock, or delisted with units) → keep the flag, but drop it
 *     when the new qty reaches 0 — a delisted line stays delisted;
 *   - untracking (new qty NULL = unlimited) re-lists a sold-out line and keeps
 *     the flag otherwise.
 *
 * Same semantics as the order restock CASE (workflows/order/restock.ts). The SQL
 * writers inline the equivalent:
 *   CASE WHEN old_qty <= 0 THEN new_qty > 0 ELSE in_stock AND new_qty > 0 END
 * They only ever touch TRACKED rows (`stock_qty IS NOT NULL` guard — a delta is
 * meaningless on an untracked line), so the untracked branch never reaches SQL.
 */
export function nextInStockForQty(
  oldQty: number | null,
  oldInStock: boolean,
  newQty: number | null,
): boolean {
  const wasSoldOut = oldQty !== null && oldQty <= 0;
  if (newQty === null) return wasSoldOut ? true : oldInStock;
  if (wasSoldOut || oldQty === null) return newQty > 0;
  return oldInStock && newQty > 0;
}

/** Quantity-aware availability: flagged in stock AND (untracked or qty > 0). */
export function isAvailable(inStock: boolean, qty: number | null): boolean {
  return inStock && (qty === null || qty > 0);
}
