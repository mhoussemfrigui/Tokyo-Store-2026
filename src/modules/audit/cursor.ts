/**
 * PURE keyset-cursor helpers for the audit list — NO "server-only", NO DB
 * import, so they are unit-testable. The actual drizzle predicate is built in
 * queries.ts; this module owns the cursor encoding + the limit clamp.
 *
 * THE CURSOR IS THE ROW id (uuid v7), NOT created_at. Why: audit_log is the
 * highest-write-rate table (every bus emit writes a row, several can land in
 * the same millisecond), and created_at is stored at MICROSECOND precision
 * while any JS Date / ISO string the cursor can carry is only MILLISECOND. A
 * created_at-only `< cursor` keyset therefore skips rows that share a
 * millisecond across a page boundary (the bug fixed here). uuid v7 is
 * time-ordered (to MILLISECOND resolution) AND unique, so ordering by `id DESC`
 * is newest-first — with the caveat that rows minted in the SAME millisecond
 * order arbitrarily (v7 has no intra-ms counter; their tail bits are random),
 * which is immaterial for an activity log. The `id < cursor` keyset is EXACT
 * either way — no skips, no dups.
 */

import { parseStoreLocalDateTime } from "@/lib/time/store-tz";

export const AUDIT_LIST_MAX = 200;
export const AUDIT_LIST_DEFAULT = 50;

/** Clamp a requested page size to [1, AUDIT_LIST_MAX], default AUDIT_LIST_DEFAULT. */
export function clampAuditLimit(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return AUDIT_LIST_DEFAULT;
  return Math.max(1, Math.min(Math.floor(n), AUDIT_LIST_MAX));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A cursor is valid only if it is a uuid — guards the SQL from a junk param. */
export function isValidAuditCursor(raw: string | null | undefined): raw is string {
  return typeof raw === "string" && UUID_RE.test(raw);
}

/** Normalise a raw cursor input to a usable id, or null (ignored by the query). */
export function parseAuditCursor(raw: string | null | undefined): string | null {
  return isValidAuditCursor(raw) ? raw : null;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The UTC instant a `YYYY-MM-DD` calendar day STARTS in the store zone
 * (Africa/Tunis → 23:00Z the day before), or null when it isn't a real date.
 * `parseStoreLocalDateTime` resolves the offset per day, so it stays exact if
 * the zone ever gains DST.
 */
function storeDayStart(y: number, m: number, d: number): Date | null {
  const probe = new Date(Date.UTC(y, m - 1, d));
  // Reject roll-overs (2026-02-30 → 2 March) — an invalid date is ignored.
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return parseStoreLocalDateTime(`${probe.toISOString().slice(0, 10)}T00:00`);
}

/**
 * Parse the Journal's `from`/`to` date-range inputs into created_at bounds.
 * The inputs are `<input type="date">` days, read as STORE-LOCAL (Africa/Tunis)
 * days — a bare `new Date("2026-06-22")` is UTC midnight, which made "today"
 * run 01:00→00:59 Tunis (missing the first local hour, leaking the next day's).
 * `from` = the store day's first instant; `to` = its LAST instant (inclusive,
 * so a same-day from/to — and a plain `to=2026-06-22` — matches that whole
 * day). A value that isn't a bare day (hand-typed URL) is taken as an exact
 * instant: a naked wall-clock as store time, an ISO string with a zone as-is.
 * Shared by the page RSC, the load-more action and the CSV export route (via
 * normalizeAuditFilters) so the on-screen and export windows can never drift.
 */
export function parseAuditDateWindow(
  fromRaw: string | null | undefined,
  toRaw: string | null | undefined,
): { from?: Date; to?: Date } {
  const parse = (v: string | null | undefined, edge: "start" | "end"): Date | undefined => {
    const t = v?.trim();
    if (!t) return undefined;
    const day = DAY_RE.exec(t);
    if (!day) return parseStoreLocalDateTime(t) ?? undefined;
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    if (edge === "start") return storeDayStart(y, m, d) ?? undefined;
    // End of the store day = the next store day's start − 1 ms.
    if (!storeDayStart(y, m, d)) return undefined;
    const next = storeDayStart(...nextDay(y, m, d));
    return next ? new Date(next.getTime() - 1) : undefined;
  };
  return { from: parse(fromRaw, "start"), to: parse(toRaw, "end") };
}

function nextDay(y: number, m: number, d: number): [number, number, number] {
  const n = new Date(Date.UTC(y, m - 1, d + 1));
  return [n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()];
}

/** Raw audit filter inputs (URL/query strings), as the page + export + the
 *  load-more action all receive them. */
export type RawAuditFilters = {
  event?: string | null;
  domain?: string | null;
  severity?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  actor?: string | null;
  summary?: string | null;
  from?: string | null;
  to?: string | null;
};

/** Normalised filter shape consumed by listAuditEntries (structurally matches
 *  its AuditListFilters — kept here so the pure normalizer needs no server import). */
export type NormalizedAuditFilters = {
  eventName?: string;
  domain?: string;
  severity?: string;
  targetType?: string;
  targetId?: string;
  actorUserId?: string;
  summary?: string;
  from?: Date;
  to?: Date;
};

const clean = (v: string | null | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/**
 * Single source of truth for turning the raw audit filter inputs into the
 * normalised query filters (trim, drop blanks, remap event→eventName /
 * actor→actorUserId, from/to = store-local (Africa/Tunis) days, `to` inclusive
 * to the end of its day). Used by the page RSC, the CSV
 * export route, and the load-more action so the three can never drift.
 */
export function normalizeAuditFilters(raw: RawAuditFilters): NormalizedAuditFilters {
  const { from, to } = parseAuditDateWindow(raw.from, raw.to);
  return {
    eventName: clean(raw.event),
    domain: clean(raw.domain),
    severity: clean(raw.severity),
    targetType: clean(raw.targetType),
    targetId: clean(raw.targetId),
    actorUserId: clean(raw.actor),
    summary: clean(raw.summary),
    from,
    to,
  };
}
