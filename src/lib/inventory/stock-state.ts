/**
 * PURE stock-state predicates for the ADMIN displays (Stock table badges, the
 * Produits list pill) — the JS twins of the SQL filters in
 * `stockStateSql` (modules/catalog/product/queries.ts), so a row's badge always
 * agrees with the filter chip that lists it. No server-only deps (client-safe).
 */
import { isAvailable } from "./in-stock-rule";

/**
 * « Rupture » — the exact complement of sellable (`isAvailable`): unticked
 * Disponible, OR a TRACKED quantity at/below 0. A line saved at qty 0 with
 * Disponible still ticked is unbuyable on the storefront, so it must read
 * Rupture (not a green « OK ») and sit in the Rupture filter.
 */
export function isEffectivelyOutOfStock(inStock: boolean, stockQty: number | null): boolean {
  return !isAvailable(inStock, stockQty);
}

/**
 * « Bas » — sellable with a tracked quantity in [1, threshold]. `threshold` is
 * the operator's `stock.low_threshold_qty` (resolveLowStockConfig — the same line
 * the low-stock alert emails use); ≤ 0 disables the tier.
 */
export function isLowStock(inStock: boolean, stockQty: number | null, threshold: number): boolean {
  return threshold > 0 && isAvailable(inStock, stockQty) && stockQty !== null && stockQty <= threshold;
}
