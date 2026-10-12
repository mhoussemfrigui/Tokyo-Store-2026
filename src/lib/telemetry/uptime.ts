/**
 * PURE uptime/downtime computation from the instance-heartbeat trail — no
 * "server-only", no DB, so it is unit-tested directly. Given the boot rows that
 * overlap the window (each: when it started, when it was last seen, and whether
 * it stopped cleanly), infer restarts and outage windows. Each row covers the
 * interval [started_at, stopped_at / last_seen_at]; downtime is the part of the
 * window NOT covered by the UNION of those intervals, counting only uncovered
 * spans longer than a grace of ~2× the heartbeat interval.
 *
 * Union, not neighbour-to-neighbour: with overlapping instances (replicas, a
 * rolling redeploy), a short-lived instance followed later by a new boot must
 * not read as an outage while a long-lived instance was serving the whole time,
 * and the trailing check uses the LATEST end across every instance, not the
 * newest-started one's.
 *
 * Conservative by design: only counts downtime AFTER the first observed coverage
 * (between instances, plus a trailing gap if every instance went silent), never
 * a leading gap before the earliest row (we can't know the app's state before
 * the trail starts).
 */

export type HeartbeatLike = {
  startedAt: Date | number | string;
  lastSeenAt: Date | number | string;
  stoppedAt: Date | number | string | null;
};

export type UptimeStats = {
  /** Instances alive at some point in the window (incl. ones booted before it). */
  instances: number;
  /**
   * Boots INSIDE the window that followed an earlier instance: the earliest
   * in-window boot counts only when an instance was already running from before
   * the window (0 for a single continuous instance).
   */
  restarts: number;
  /** Summed inferred downtime in ms (clamped to the window). */
  downtimeMs: number;
  /** Window length minus downtime, clamped to ≥ 0. */
  uptimeMs: number;
  /** uptimeMs / windowMs × 100 (100 when the window is empty). */
  availabilityPct: number;
  /** Each detected outage window. */
  gaps: Array<{ fromMs: number; toMs: number; ms: number }>;
  /** Epoch ms of the most recent boot among the rows (null if none). */
  lastRestartAt: number | null;
};

function ms(v: Date | number | string): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number") return v;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/**
 * @param rows heartbeat rows overlapping the window (any order; sorted
 *   internally by startedAt)
 * @param opts.heartbeatIntervalSec the configured beat cadence (grace = 2×)
 * @param opts.windowStartMs left edge of the analysis window
 * @param opts.nowMs right edge (current time)
 */
export function computeUptimeStats(
  rows: HeartbeatLike[],
  opts: { heartbeatIntervalSec: number; windowStartMs: number; nowMs: number },
): UptimeStats {
  const { windowStartMs, nowMs } = opts;
  const windowMs = Math.max(0, nowMs - windowStartMs);
  const graceMs = Math.max(60_000, opts.heartbeatIntervalSec * 1000 * 2);

  // Normalise each row to its coverage interval + sort by start; drop rows with
  // an unparseable start. The end is the later of the last beat and a clean
  // stop (the stop is stamped after the final beat); an unparseable end
  // collapses to the start (the row still proves the instance booted).
  const norm = rows
    .map((r) => {
      const start = ms(r.startedAt);
      const ends = [ms(r.lastSeenAt), r.stoppedAt == null ? NaN : ms(r.stoppedAt)].filter(
        Number.isFinite,
      );
      return { start, end: ends.length > 0 ? Math.max(start, ...ends) : start };
    })
    .filter((r) => Number.isFinite(r.start))
    .sort((a, b) => a.start - b.start);

  const gaps: UptimeStats["gaps"] = [];
  const clamp = (x: number) => Math.max(windowStartMs, Math.min(nowMs, x));
  const pushGap = (from: number, to: number) => {
    const gapStart = clamp(from);
    const gapEnd = clamp(to);
    if (gapEnd - gapStart > graceMs) {
      gaps.push({ fromMs: gapStart, toMs: gapEnd, ms: gapEnd - gapStart });
    }
  };

  // Sweep the start-sorted intervals, tracking how far the union covers so far:
  // a boot that starts after that frontier opens an uncovered span.
  let coveredUntil = Number.NEGATIVE_INFINITY;
  for (const r of norm) {
    if (Number.isFinite(coveredUntil) && r.start > coveredUntil) pushGap(coveredUntil, r.start);
    coveredUntil = Math.max(coveredUntil, r.end);
  }

  // Trailing gap: every instance went silent (no heartbeat within grace) and
  // none is still covering → treat the silence-to-now span as downtime.
  if (norm.length > 0 && nowMs - coveredUntil > graceMs) pushGap(coveredUntil, nowMs);

  const downtimeMs = gaps.reduce((sum, g) => sum + g.ms, 0);
  const uptimeMs = Math.max(0, windowMs - downtimeMs);
  const availabilityPct =
    windowMs > 0 ? Math.max(0, Math.min(100, (uptimeMs / windowMs) * 100)) : 100;
  const instances = norm.length;
  // A boot inside the window is a restart when something ran before it; the
  // earliest in-window boot is only the first observation unless an instance
  // was carried over from before the window.
  const bootsInWindow = norm.filter((r) => r.start >= windowStartMs).length;
  const carriedOver = instances > bootsInWindow;
  const restarts = carriedOver ? bootsInWindow : Math.max(0, bootsInWindow - 1);

  return {
    instances,
    restarts,
    downtimeMs,
    uptimeMs,
    availabilityPct: Math.round(availabilityPct * 100) / 100,
    gaps,
    lastRestartAt: instances > 0 ? norm[norm.length - 1].start : null,
  };
}
