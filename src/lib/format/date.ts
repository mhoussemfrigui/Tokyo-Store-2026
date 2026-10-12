/**
 * Shared fr-FR date formatters. ONE place for the locale + option objects so
 * the ~25 hand-rolled `new Date(x).toLocaleDateString("fr-FR", {...})` calls
 * (and the two copy-pasted `formatDate` helpers) render consistently. Reuses a
 * single Intl.DateTimeFormat instance per format (cheaper than constructing one
 * per call).
 */
const SHORT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const LONG = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const FULL = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });

function toDate(input: Date | string | number | null | undefined): Date | null {
  if (input == null) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "12 mars" — short day + month. Empty string for null/invalid input. */
export function formatDate(input: Date | string | number | null | undefined): string {
  const d = toDate(input);
  return d ? SHORT.format(d) : "";
}

/** "12 mars 2026" — day + month + year. Empty string for null/invalid input. */
export function formatDateLong(input: Date | string | number | null | undefined): string {
  const d = toDate(input);
  return d ? LONG.format(d) : "";
}

/**
 * "12 janvier 2026" — day-numeric + month-long + year-numeric. The ONE place
 * for the spelled-out-month format hand-rolled as `toLocaleDateString("fr-FR",
 * { day: "numeric", month: "long", year: "numeric" })` across the verify /
 * stock surfaces. Empty string for null/invalid input.
 */
export function formatDateFull(input: Date | string | number | null | undefined): string {
  const d = toDate(input);
  return d ? FULL.format(d) : "";
}
