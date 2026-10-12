/**
 * Safety ceiling on how many products a storefront grid (category / sub-category /
 * brand / collection) loads + enriches + ships in ONE request. The grids load the
 * full matched set for client-side faceted sort/filter; that's fine for realistic
 * catalogues (hundreds to a few thousand per category) but would OOM/timeout on a
 * pathological set. Above this ceiling we cap (and log) so a single category can
 * never take the page down — well clear of any realistic catalogue, so it's a
 * no-op in practice. (A deeper fix — DB keyset pagination + server-side facets —
 * is the path if catalogues ever genuinely exceed this.)
 *
 * Pure (no DB / server deps) so it's unit-testable.
 */
export const MAX_GRID_PRODUCTS = 2000;

/** Cap a storefront-grid id set to MAX_GRID_PRODUCTS, logging once when it bites. */
export function capGridIds(ids: string[], label: string): string[] {
  if (ids.length <= MAX_GRID_PRODUCTS) return ids;
  console.warn(
    `[catalog] ${label} matched ${ids.length} products; capping the grid to ${MAX_GRID_PRODUCTS}. Consider DB pagination if this is intentional.`,
  );
  return ids.slice(0, MAX_GRID_PRODUCTS);
}
