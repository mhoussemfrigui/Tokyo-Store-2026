import type { DispatchCadence } from "./registry";

/**
 * PURE due-ness for the single dispatch heartbeat (no DB, no "server-only" — unit-
 * testable). Given a job's cadence, its last-run instant, and now, decides whether
 * the dispatcher (`/api/cron/dispatch`) should run it THIS tick. Store timezone is
 * Africa/Tunis = fixed +01:00 (no DST), so store wall-clock = UTC + 1h.
 *
 * `interval`      → due when `now - lastRun >= everyMinutes` (or it never ran).
 * `daily`         → due once the store-local atHour:atMinute has passed today AND
 *                   the job hasn't already run since that instant.
 * `opportunistic` → never scheduled here (runs off traffic / its own timer).
 * `internal`      → an in-app timer the dispatcher ignores.
 */
const STORE_OFFSET_MS = 3_600_000; // +01:00

// Slack absorbed when deciding an INTERVAL job is due. `lastRunAtMs` is the run's
// START (the dispatcher anchors on the last executed run's `started_at` — see
// dispatch/route.ts), so cadence is start-to-start and a long run can't halve the rate.
// The external heartbeat still has jitter, so a job whose `everyMinutes` equals the
// heartbeat period could measure slightly LESS than `every` elapsed on the matching
// tick and wait a whole extra period — a 2-min job on a 2-min beat would then run every
// 4 min. Firing when we are within this slack of the target keeps cadence honest without
// letting a job double-fire (the slack is far below any real interval; overlap is also
// guarded by each drain's own single-flight / advisory lock).
const INTERVAL_SLACK_MS = 30_000;

/** UTC-ms of today's store-local (atHour:atMinute) instant, relative to `nowMs`. */
export function storeDailyInstantMs(nowMs: number, atHour: number, atMinute: number): number {
  const local = new Date(nowMs + STORE_OFFSET_MS); // store wall clock
  // Store-local (y,m,d, atHour:atMinute) as an absolute instant = that UTC wall
  // time minus the +01:00 offset.
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), atHour, atMinute) - STORE_OFFSET_MS;
}

export function isJobDue(cadence: DispatchCadence, lastRunAtMs: number | null, nowMs: number): boolean {
  switch (cadence.mode) {
    case "interval": {
      const every = Math.max(1, cadence.everyMinutes) * 60_000;
      return lastRunAtMs == null || nowMs - lastRunAtMs >= every - INTERVAL_SLACK_MS;
    }
    case "daily": {
      const scheduled = storeDailyInstantMs(nowMs, cadence.atHour, cadence.atMinute);
      if (nowMs < scheduled) return false; // today's time hasn't arrived yet
      return lastRunAtMs == null || lastRunAtMs < scheduled; // not yet run since it
    }
    case "opportunistic":
    case "internal":
      return false;
  }
}

/** Cadences the dispatch heartbeat is responsible for (interval + daily only). */
export function isDispatchable(cadence: DispatchCadence): boolean {
  return cadence.mode === "interval" || cadence.mode === "daily";
}

/**
 * The NEXT time the dispatcher would fire a job (for the admin « Prochaine » column).
 * `interval` → lastRun + everyMinutes (or now if never run / overdue). `daily` →
 * today's store-local instant if it hasn't run since it, otherwise tomorrow's.
 * Returns null for cadences the heartbeat never dispatches. Pure.
 */
export function nextDispatchAtMs(cadence: DispatchCadence, lastRunAtMs: number | null, nowMs: number): number | null {
  switch (cadence.mode) {
    case "interval": {
      if (lastRunAtMs == null) return nowMs;
      // Subtract the same slack isJobDue applies, so « Prochaine » shows the EARLIEST
      // instant the heartbeat will actually fire the job (not a moment up to the slack
      // later, which would read as "in 20s" on the very tick it already runs).
      const next = lastRunAtMs + Math.max(1, cadence.everyMinutes) * 60_000 - INTERVAL_SLACK_MS;
      return Math.max(next, nowMs);
    }
    case "daily": {
      const today = storeDailyInstantMs(nowMs, cadence.atHour, cadence.atMinute);
      // Due today (time reached, not yet run since) → next fire is the very next tick.
      if (nowMs >= today && (lastRunAtMs == null || lastRunAtMs < today)) return nowMs;
      // Otherwise the next occurrence is today (if still upcoming) or tomorrow.
      return nowMs < today ? today : today + 86_400_000;
    }
    case "opportunistic":
    case "internal":
      return null;
  }
}
