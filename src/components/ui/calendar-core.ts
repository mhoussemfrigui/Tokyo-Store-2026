/**
 * Shared, dependency-free calendar math for the date widgets (the popover
 * `DateField` and the inline `InlineCalendar`). Dates are plain 'YYYY-MM-DD'
 * strings in the LOCAL frame — the same shape the birthday / appointment_date
 * columns store — so there is no timezone drift. Keeping this in ONE module
 * avoids re-deriving weekday/grid logic per widget.
 */

export const WEEKDAYS = ["Lu", "Ma", "Me", "Je", "Ve", "Sa", "Di"];
export const MONTHS = [
  "janvier", "février", "mars", "avril", "mai", "juin",
  "juillet", "août", "septembre", "octobre", "novembre", "décembre",
];
export const MONTHS_SHORT = [
  "janv.", "févr.", "mars", "avr.", "mai", "juin",
  "juil.", "août", "sept.", "oct.", "nov.", "déc.",
];

export const pad = (n: number) => String(n).padStart(2, "0");
export const toYmd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** Today as a LOCAL-frame 'YYYY-MM-DD'. Use this for a `max`/`min` bound rather than
 *  `new Date().toISOString().slice(0,10)` (which is UTC) — the calendar's default view
 *  is local, so a UTC bound would wrongly disable "today" for the ~1h after local
 *  midnight in positive-offset zones (Africa/Tunis is UTC+1). */
export function todayYmd(): string {
  const d = new Date();
  return toYmd(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Parse 'YYYY-MM-DD' → {y,m(0-11),d} or null. Avoids Date() TZ parsing. */
export function parseYmd(v: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

export function formatYmd(v: string): string {
  const p = parseYmd(v);
  return p ? `${p.d} ${MONTHS[p.m]} ${p.y}` : "";
}

/** Monday-first weekday index (0=Mon … 6=Sun) of a JS getDay() value. */
export const mondayIdx = (jsDay: number) => (jsDay + 6) % 7;

/** Days in a (year, 0-based month). */
export const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The cells of a Monday-first month grid: leading `null`s then day numbers 1..n. */
export function monthGridCells(y: number, m: number): Array<number | null> {
  const lead = mondayIdx(new Date(Date.UTC(y, m, 1)).getUTCDay());
  const dim = daysInMonth(y, m);
  const cells: Array<number | null> = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= dim; d++) cells.push(d);
  return cells;
}
