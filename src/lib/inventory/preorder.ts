/**
 * Précommande (preorder) predicate — pure + client-safe (no server-only), so the
 * storefront buy-gate and the order workflow share ONE definition.
 *
 * A product is an ACTIVE preorder when it is flagged AND has not released yet (no
 * date = indefinitely on preorder). Once `preorder_releases_at` passes it reverts
 * to a normal sale: placement decrements stock again and the storefront drops the
 * preorder CTA. See `@/lib/order/preorder-state` for the order-side helpers.
 */
export function isActivePreorder(
  p: { is_preorder: boolean; preorder_releases_at: Date | string | null },
  now: Date = new Date(),
): boolean {
  if (!p.is_preorder) return false;
  const releases = p.preorder_releases_at;
  if (releases == null) return true; // flagged, no date → always on preorder
  const ts = typeof releases === "string" ? new Date(releases).getTime() : releases.getTime();
  if (Number.isNaN(ts)) return true;
  return ts > now.getTime();
}

/**
 * Sellable units RIGHT NOW = tracked stock minus the units held by open
 * précommande reservations (`reserved_qty`). A reserved unit is promised to a
 * preorder, so it must not be counted as available to a new regular buyer.
 * Untracked stock (`stock_qty` null) stays unbounded → `null` (always sellable).
 * Never negative (a transient over-reserve clamps to 0). Pure + client-safe.
 */
export function availableStock(
  stockQty: number | null | undefined,
  reservedQty: number | null | undefined,
): number | null {
  if (stockQty == null) return null;
  return Math.max(0, stockQty - (reservedQty ?? 0));
}
