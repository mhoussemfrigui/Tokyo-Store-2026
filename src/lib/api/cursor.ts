/**
 * Shared incremental-sync cursor parsing for the external API's keyset-paginated
 * READ endpoints (orders, customers, stock/loyalty movements). The three-gate
 * ISO validation (regex + CALENDAR check + Date range) is what keeps a bad
 * `since` a clean 400 instead of a `::timestamptz` 22007/22008 → 500 downstream
 * (the readers bind the raw string as a cast — see `@/lib/api/keyset`).
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

/**
 * True when the string's date part is a REAL calendar day and its offset is one
 * Postgres accepts. `new Date()` alone isn't enough: V8 silently ROLLS OVER day
 * overflow (`2025-02-30` → 2025-03-02) and accepts year 0 / offsets past ±15h,
 * all of which Postgres rejects with 22008 — so the Date gate would pass them
 * and the `::timestamptz` cast would 500 (or, before the cast fix, silently
 * shift the watermark). Assumes `ISO_DT_RE` already matched.
 */
function isCalendarValid(s: string): boolean {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  // Day 0 of the NEXT month = the last day of month `m` (UTC, leap-year aware).
  if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return false;
  const tz = /([+-])(\d{2}):?(\d{2})$/.exec(s.slice(10));
  if (tz && (Number(tz[2]) > 15 || Number(tz[3]) > 59)) return false;
  return true;
}

export type ParsedCursor =
  | { ok: true; sinceIso?: string; sinceId?: string; limit: number }
  | { ok: false; error: string };

export function parseIncrementalCursor(params: URLSearchParams, maxLimit = 200): ParsedCursor {
  const sinceRaw = params.get("since")?.trim() || undefined;
  if (
    sinceRaw &&
    (!ISO_DT_RE.test(sinceRaw) || !isCalendarValid(sinceRaw) || Number.isNaN(new Date(sinceRaw).getTime()))
  ) {
    return { ok: false, error: "since doit être un timestamp ISO." };
  }
  // A malformed sinceId is IGNORED (falls back to the inclusive `since` watermark)
  // rather than 400 — forgiving for callers, matching /api/orders.
  const sinceIdRaw = params.get("sinceId")?.trim();
  const sinceId = sinceIdRaw && UUID_RE.test(sinceIdRaw) ? sinceIdRaw : undefined;
  // `Number(null)` (absent) and `Number("")` (blank) are BOTH 0 — which is finite
  // — so testing `Number.isFinite` on them would clamp the default up to 1 and make
  // every un-parameterized sync page return a single row (≈50× round-trips). Treat
  // absent/blank as "use the default" explicitly.
  const limitParam = params.get("limit")?.trim();
  const limitRaw = limitParam ? Number(limitParam) : NaN;
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), maxLimit) : 50;
  return { ok: true, sinceIso: sinceRaw, sinceId, limit };
}
