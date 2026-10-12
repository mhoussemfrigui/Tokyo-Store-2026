/**
 * Fiscal-year bucket for per-year GAPLESS document numbering (invoices, credit
 * notes, delivery notes). Computed in the STORE's timezone (Africa/Tunis, UTC+1)
 * — NOT the raw UTC server clock — so a document issued in the first hour of
 * Jan 1 local time (which is still Dec 31 in UTC) is not mis-bucketed into the
 * previous year's sequence. Pure + injectable for testing.
 */
const FISCAL_TIME_ZONE = "Africa/Tunis";

export function fiscalYear(now: Date = new Date()): string {
  // en-CA → "YYYY"; timeZone shifts the instant to local civil time first.
  return new Intl.DateTimeFormat("en-CA", { timeZone: FISCAL_TIME_ZONE, year: "numeric" }).format(now);
}
