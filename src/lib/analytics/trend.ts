/**
 * Pure trend / delta helpers for the admin Tableau de bord + Statistiques.
 *
 * No DB, no `server-only` — fully unit-testable and safe to import from client
 * components. The pages fetch a 2×window daily series, split it into the current
 * and previous halves with {@link splitWindow}, then compute period-over-period
 * deltas with {@link computeDelta}. Keeping the maths here (not inline in the
 * RSC) is what makes it testable without a database.
 */

export type TrendDirection = "up" | "down" | "flat";

export type Delta = {
  current: number;
  previous: number;
  /** `current - previous`. */
  absolute: number;
  /**
   * Whole-percent change vs the previous period, or `null` when there is no
   * baseline (`previous === 0` and `current > 0`) — the UI shows "nouveau"
   * instead of a meaningless ∞%. A 0→0 period is a flat `0`, not `null`.
   */
  pct: number | null;
  direction: TrendDirection;
};

/** Period-over-period delta between a current and previous value. */
export function computeDelta(current: number, previous: number): Delta {
  const cur = Number.isFinite(current) ? current : 0;
  const prev = Number.isFinite(previous) ? previous : 0;
  const absolute = cur - prev;
  let pct: number | null;
  if (prev === 0) {
    pct = cur === 0 ? 0 : null; // 0→0 is flat; 0→n has no baseline (∞)
  } else {
    pct = Math.round((absolute / prev) * 100);
  }
  const direction: TrendDirection = absolute > 0 ? "up" : absolute < 0 ? "down" : "flat";
  return { current: cur, previous: prev, absolute, pct, direction };
}

/** Sum a numeric field across rows (0 for an empty list; coerces non-finite to 0). */
export function sumBy<T>(rows: readonly T[], pick: (row: T) => number): number {
  let total = 0;
  for (const r of rows) {
    const v = pick(r);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

/**
 * Split a chronological (oldest-first) series into its `previous` and `current`
 * halves of `window` rows each. Slices from the END so a longer-than-2×window
 * series still yields the latest two windows; a shorter series degrades
 * gracefully (the previous half may be shorter / empty rather than throwing).
 */
export function splitWindow<T>(
  series: readonly T[],
  window: number,
): { previous: T[]; current: T[] } {
  const w = Math.max(0, Math.floor(window));
  const n = series.length;
  const current = series.slice(Math.max(0, n - w));
  const previous = series.slice(Math.max(0, n - 2 * w), Math.max(0, n - w));
  return { previous: [...previous], current: [...current] };
}

/** Average order value in minor units (0 when there are no orders). */
export function aovCents(revenueCents: number, orders: number): number {
  if (!orders || orders <= 0) return 0;
  return Math.round(revenueCents / orders);
}

/** Share of `part` within `total` as a whole percent (0 when `total` ≤ 0). */
export function sharePct(part: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.round((part / total) * 100);
}
