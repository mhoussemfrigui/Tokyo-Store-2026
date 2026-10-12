/**
 * Cached-total maintenance for multi-location stock — PURE (no server-only
 * deps), so it's unit-testable in isolation. The product/variant `stock_qty`
 * column is the authoritative sellable TOTAL, kept as the cached sum of the
 * per-location `stock_levels`.
 */

/**
 * The cached total after a per-location level write:
 *   - untracked target (oldTotal NULL) → transitions to tracked = the sum of
 *     its active-location levels;
 *   - tracked target → moves by the level delta, so a concurrent order
 *     decrement is preserved (never clobbered by a stale sum). Floored at 0.
 */
export function nextTotalForLevelWrite(
  oldTotal: number | null,
  delta: number,
  sumActiveLevels: number,
): number {
  // Defensive: a non-finite or negative input (the DB CHECK + coalesced SUM
  // should prevent it, but never write NaN/negative to stock_qty) → 0.
  const clamp = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  return oldTotal == null ? clamp(sumActiveLevels) : clamp(oldTotal + delta);
}
