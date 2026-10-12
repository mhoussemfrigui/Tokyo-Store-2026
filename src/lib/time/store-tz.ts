/**
 * Store-timezone helpers for admin `datetime-local` inputs.
 *
 * The shop is Tunisia (Africa/Tunis, UTC+1, no DST today). Admin schedule
 * fields — promotion `starts_at/ends_at`, banner `start_at/end_at` — are
 * `<input type="datetime-local">`, which yields a NAKED wall-clock string
 * (`YYYY-MM-DDTHH:mm`, no offset). Two things must agree on the frame that
 * string is in, or a scheduled window drifts:
 *
 *   - PARSE (server): `new Date("2026-01-01T09:00")` interprets the string in
 *     the RUNTIME zone — UTC in a Coolify/Docker container — so "09:00" is
 *     stored as 09:00Z = 10:00 Tunis. Every scheduled promo/banner then goes
 *     live (and expires) an hour late in prod, while working on a Tunis-local
 *     dev box. The storefront live-window compares DB `now()` and is correct;
 *     only the STORED instant is wrong.
 *   - RENDER (client): the old `isoToLocalInput` used the operator's BROWSER
 *     zone, so an admin abroad would see/save a different wall-clock than one
 *     in Tunis.
 *
 * Both are fixed here by pinning the frame to the STORE zone (plus
 * `formatStoreDateTime` / `formatStoreDate` for DISPLAYING an instant in shop
 * time — fiscal documents, receipts, SAV dates). Pure (no
 * `server-only`, no `db`) so the client forms AND the server workflows share
 * ONE converter, and it's unit-testable without a DB or the network.
 */

/** The store's civil-time zone. Matches src/lib/fiscal-period.ts + segments.ts. */
export const STORE_TIME_ZONE = "Africa/Tunis";

const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * Minutes `timeZone` is AHEAD of UTC at `instant` (Tunis → +60). Computed via
 * Intl so it stays correct if the zone ever gains a DST rule — no hard-coded
 * offset.
 */
export function tzOffsetMinutes(instant: Date, timeZone: string = STORE_TIME_ZONE): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(instant);
  const f: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") f[p.type] = Number(p.value);
  // `hour` can be 24 at midnight under some engines' h23 — normalise to 0.
  const hour = f.hour === 24 ? 0 : f.hour;
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, hour, f.minute, f.second);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * Interpret an admin `datetime-local` wall-clock string as STORE-local time and
 * return the corresponding UTC instant. `"2026-01-01T09:00"` (09:00 Tunis) →
 * `2026-01-01T08:00:00Z`. Blank/invalid → null (schedule stays open-ended).
 *
 * Uses the offset-at-guess technique: treat the wall-clock as UTC, read the
 * zone offset at that approximate instant, then correct. Exact for a
 * fixed-offset zone like Tunis; off only inside the ~1h DST fold, which this
 * zone doesn't have.
 */
export function parseStoreLocalDateTime(s: string | null | undefined): Date | null {
  if (!s) return null;
  const trimmed = s.trim();
  // If the string already carries an explicit zone (trailing `Z` or ±HH:MM),
  // it's an absolute instant — trust it as-is, don't shift by the store offset.
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(trimmed);
  const m = hasZone ? null : WALL_CLOCK_RE.exec(trimmed);
  if (!m) {
    const d = new Date(trimmed);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const [, y, mo, d, h, mi, se] = m;
  const guessUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, se ? +se : 0);
  const offset = tzOffsetMinutes(new Date(guessUtc), STORE_TIME_ZONE);
  const dt = new Date(guessUtc - offset * 60_000);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Render a stored instant as the STORE-local `YYYY-MM-DDTHH:mm` wall-clock an
 * `<input type="datetime-local">` accepts — the inverse of
 * {@link parseStoreLocalDateTime}, so the value an admin typed round-trips
 * unchanged regardless of their browser zone. Blank/invalid → "" (no preset).
 */
export function storeLocalDateTimeInput(value: Date | string | null | undefined): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: STORE_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const f: Record<string, string> = {};
  for (const p of dtf.formatToParts(d)) if (p.type !== "literal") f[p.type] = p.value;
  const hour = f.hour === "24" ? "00" : f.hour;
  return `${f.year}-${f.month}-${f.day}T${hour}:${f.minute}`;
}

// One formatter instance per style (cheaper than constructing one per call).
const STORE_DATE_TIME_FMT = {
  /** « 1 oct. 2026, 00:30 » — admin tables / timestamps. */
  medium: new Intl.DateTimeFormat("fr-FR", {
    timeZone: STORE_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }),
  /** « 30 septembre 2026 à 23:59 » — customer-facing copy (emails). */
  long: new Intl.DateTimeFormat("fr-FR", {
    timeZone: STORE_TIME_ZONE,
    dateStyle: "long",
    timeStyle: "short",
  }),
} as const;

/**
 * Render an instant as a fr-FR date + time in the STORE zone (Africa/Tunis),
 * never the runtime zone — a server component / subscriber runs in the
 * container's UTC, so a bare `toLocaleString("fr-FR")` shows every time 1h
 * behind shop time (and a 00:30 end on the 1st as « the 30th »). Blank/invalid
 * → "" (callers pick their own placeholder).
 */
export function formatStoreDateTime(
  value: Date | string | null | undefined,
  style: keyof typeof STORE_DATE_TIME_FMT = "medium",
): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return STORE_DATE_TIME_FMT[style].format(d);
}

/**
 * Render an instant as a fr-FR calendar DATE in the STORE zone (Africa/Tunis).
 * The date-only sibling of {@link formatStoreDateTime}, for printed documents
 * (facture / avoir / bon de livraison / reçu) and SAV dates: their gapless
 * numbers (`fiscalYear()`) are store-local and the underlying timestamp must be
 * shown in the same zone, so a bare `toLocaleDateString("fr-FR")` on the UTC
 * container would date a document issued between 00:00 and 01:00 Tunis the
 * PREVIOUS day — on 1 January, the previous year next to a new-year number.
 * `opts` are any
 * date-formatting options (default « 23 septembre 2026 »; `{ dateStyle:
 * "short" }` → « 23/09/2026 »); the zone is always forced to the store's.
 * Blank/invalid → "" (callers pick their own placeholder).
 */
export function formatStoreDate(
  value: Date | string | null | undefined,
  opts: Intl.DateTimeFormatOptions = { dateStyle: "long" },
): string {
  if (!value) return "";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("fr-FR", { ...opts, timeZone: STORE_TIME_ZONE });
}
