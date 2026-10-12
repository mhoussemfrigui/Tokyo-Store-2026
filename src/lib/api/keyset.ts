import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * Shared ASC `(timestamp, id)` KEYSET for the external API's incremental-sync
 * readers (orders, customers, stock movements, loyalty movements). One
 * implementation so the four feeds can't drift apart again — three of them once
 * copied a JS-Date cursor and re-delivered the boundary row forever.
 *
 * Three rules, each guarding a real sync failure:
 *
 *  1. µs-FAITHFUL CURSOR. The columns are `timestamptz` (microseconds) but a JS
 *     Date is millisecond-only, so a `row.created_at.toISOString()` cursor is
 *     TRUNCATED (.123456 → .123). Fed back as `?since=`, the boundary row still
 *     matches `col > since`, the `id` tiebreak never applies, and a page of
 *     ≥ `limit` rows sharing one `now()` (a multi-line order, a variant save)
 *     returns the same rows forever. `keysetCursor` renders the cursor in SQL
 *     via `to_char(… 'US')` so nothing is lost on the way out.
 *
 *  2. RAW-STRING BINDING. `keysetAfter` binds the validated ISO string as a
 *     `::timestamptz` CAST — never `new Date(sinceIso)` (which would truncate a
 *     µs cursor on the way back in). `sinceIso`/`sinceId` MUST come from
 *     `parseIncrementalCursor` (calendar-checked ISO + uuid), so the casts can't
 *     raise 22007/22008/22P02.
 *
 *  3. SETTLE WINDOW. Rows are stamped with `now()` = their TRANSACTION START, but
 *     become visible at COMMIT. A long transaction (order placement: stock +
 *     ledger + tax + loyalty) can commit AFTER a later-stamped row was already
 *     paged past — its older stamp then never matches `> since` and the row is
 *     skipped for good (fatal for the append-only ledgers). `settledBefore` only
 *     returns rows older than `KEYSET_SETTLE_SECONDS`, so any transaction shorter
 *     than the window is visible before the cursor can pass its stamp. Freshly
 *     written rows therefore appear in the feeds a few seconds late — by design.
 */

/** Rows younger than this are held back from the incremental feeds (see rule 3). */
export const KEYSET_SETTLE_SECONDS = 5;

/**
 * Strictly-after predicate on `(col, idCol)`. With both parts:
 * `col > since OR (col = since AND id > sinceId)` — the boundary row is never
 * re-fetched and progress holds when many rows share one timestamp. With only
 * `sinceIso`: the legacy INCLUSIVE watermark `col >= since`. No `sinceIso` →
 * `undefined` (no filter; `and()` drops it).
 */
export function keysetAfter(
  col: AnyColumn,
  idCol: AnyColumn,
  sinceIso: string | undefined,
  sinceId: string | undefined,
): SQL | undefined {
  if (!sinceIso) return undefined;
  return sinceId
    ? sql`(${col} > ${sinceIso}::timestamptz OR (${col} = ${sinceIso}::timestamptz AND ${idCol} > ${sinceId}::uuid))`
    : sql`${col} >= ${sinceIso}::timestamptz`;
}

/** The µs-precise cursor for `col`, rendered in SQL as `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
export function keysetCursor(col: AnyColumn): SQL<string> {
  return sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * Hold back rows younger than `settleSeconds` (see rule 3). `0` disables the
 * window (tests that read back rows they just wrote) → `undefined`.
 */
export function settledBefore(col: AnyColumn, settleSeconds: number = KEYSET_SETTLE_SECONDS): SQL | undefined {
  if (!(settleSeconds > 0)) return undefined;
  return sql`${col} < now() - make_interval(secs => ${settleSeconds})`;
}
