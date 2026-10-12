import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";

/**
 * Postgres-backed fixed-window rate limiter for OUR public endpoints
 * (newsletter signup, search, etc.). Better Auth has its own table for
 * /api/auth/*.
 *
 * Usage:
 *   const ok = await checkRateLimit({
 *     bucket: `newsletter:${ip ?? "anon"}`,
 *     max: 3,
 *     windowSeconds: 60,
 *   });
 *   if (!ok) return { ok: false, message: "Trop de tentatives. Réessayez plus tard." };
 *
 * Implementation: single round-trip INSERT ... ON CONFLICT DO UPDATE that
 * increments the counter. Caller checks the returned count vs max. No
 * SELECT-then-UPDATE race window. The `rate_limit_buckets` table is raw SQL
 * in the baseline migration (not in schema.ts).
 */

export type RateLimitOptions = {
  /** Stable key per (endpoint, identifier). E.g. `"newsletter:1.2.3.4"`. */
  bucket: string;
  /** Max requests allowed within the window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

export type RateLimitResult = {
  /** true if request is within cap, false if it exceeded. */
  ok: boolean;
  /** Current count after the increment. */
  count: number;
  /** Unix epoch seconds when the bucket resets. */
  resetAt: number;
};

export async function checkRateLimit(opts: RateLimitOptions): Promise<RateLimitResult> {
  const { bucket, max, windowSeconds } = opts;
  if (max <= 0 || windowSeconds <= 0) {
    return { ok: true, count: 0, resetAt: 0 };
  }

  // The atomic upsert below either inserts a fresh bucket with count=1, or —
  // when a non-expired row already exists — bumps `count` by 1. When the
  // existing row has expired (`expires_at <= now()`), we reset it back to a
  // single request inside this window.
  const rows = await db.execute<{
    count: number;
    expires_at: Date;
  }>(sql`
    INSERT INTO rate_limit_buckets (bucket_key, count, expires_at, first_seen)
    VALUES (
      ${bucket},
      1,
      now() + (${windowSeconds} || ' seconds')::interval,
      now()
    )
    ON CONFLICT (bucket_key) DO UPDATE SET
      count = CASE
        WHEN rate_limit_buckets.expires_at <= now() THEN 1
        ELSE rate_limit_buckets.count + 1
      END,
      expires_at = CASE
        WHEN rate_limit_buckets.expires_at <= now()
          THEN now() + (${windowSeconds} || ' seconds')::interval
        ELSE rate_limit_buckets.expires_at
      END,
      first_seen = CASE
        WHEN rate_limit_buckets.expires_at <= now() THEN now()
        ELSE rate_limit_buckets.first_seen
      END
    RETURNING count, expires_at
  `);
  // Opportunistically prune expired buckets so the table doesn't grow
  // unbounded without an external cron. This runs on the same request path
  // but is kept off the hot path: it's gated to ~1-in-200 calls AND only
  // fires when no sweep is already running, then is dispatched
  // fire-and-forget so it never adds latency to the rate-limit decision.
  maybeSweepExpired();

  const row = rows.rows[0];
  if (!row) {
    // Should not happen — degrade to "allow" so a DB hiccup doesn't lock
    // legitimate visitors out. Better Auth makes the same trade-off.
    return { ok: true, count: 1, resetAt: Math.floor(Date.now() / 1000) + windowSeconds };
  }
  const count = Number(row.count);
  return {
    ok: count <= max,
    count,
    resetAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
  };
}

/**
 * READ-ONLY look at a bucket: would one more `checkRateLimit` on it still be
 * within `max`? Never increments (and never creates) the row — for call sites
 * that must refuse an over-cap caller up front but only COUNT the attempts that
 * actually succeeded (see `recordOrderPlaced`). An expired bucket reads as 0.
 * `ok` is `count < max`, the exact complement of the post-increment
 * `count <= max` test in {@link checkRateLimit}, so peek + record enforce the
 * same cap. Not atomic with the later increment: two concurrent callers can both
 * pass a peek at `max - 1` (a soft cap, fine for abuse throttling).
 */
export async function peekRateLimit(
  opts: Pick<RateLimitOptions, "bucket" | "max">,
): Promise<{ ok: boolean; count: number }> {
  const { bucket, max } = opts;
  if (max <= 0) return { ok: true, count: 0 };
  const rows = await db.execute<{ count: number }>(sql`
    SELECT count FROM rate_limit_buckets
    WHERE bucket_key = ${bucket} AND expires_at > now()
  `);
  const count = Number(rows.rows[0]?.count ?? 0);
  return { ok: count < max, count };
}

/** Probability that any given `checkRateLimit` call triggers a sweep. */
const SWEEP_PROBABILITY = 1 / 200;
/** Min gap between sweeps so a burst of checks can't fire many in a row. */
const SWEEP_MIN_INTERVAL_MS = 60_000;
let sweepInFlight = false;
let lastSweepAt = 0;

/**
 * Best-effort, fire-and-forget prune used from the rate-limit hot path.
 * Cheap to call: most invocations return immediately after a coin-flip /
 * in-flight / cooldown check, and the actual DELETE is dispatched without
 * being awaited so it never blocks the caller.
 */
function maybeSweepExpired(): void {
  if (sweepInFlight) return;
  if (Math.random() >= SWEEP_PROBABILITY) return;
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  sweepInFlight = true;
  lastSweepAt = now;
  void sweepExpiredRateLimits()
    .catch((err) => {
      // Housekeeping must never surface to the request — log and move on.
      console.error("[rate-limit] opportunistic sweep failed (non-fatal)", err);
    })
    .finally(() => {
      sweepInFlight = false;
    });
}

/**
 * Best-effort housekeeping. Runs opportunistically from {@link checkRateLimit}
 * (see {@link maybeSweepExpired}); also safe to schedule via cron or call from
 * any boot task.
 */
export async function sweepExpiredRateLimits(): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`
    DELETE FROM rate_limit_buckets WHERE expires_at < now() RETURNING bucket_key
  `);
  return result.rowCount ?? 0;
}
