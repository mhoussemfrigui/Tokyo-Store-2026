/**
 * Pure bucketing for the admin dashboard "Chiffre d'affaires" chart. Kept free
 * of any React/Next import so it's unit-testable and so the chart component is a
 * thin renderer. One real daily series (up to ~365 rows from
 * `getDailyOrdersSeries`) is bucketed three ways, entirely client-side — no
 * extra DB round-trips and no fabricated points:
 *   - mois      → the last 30 days, one point per day
 *   - trimestre → the last ~13 weeks, one point per week (revenue summed)
 *   - annee     → the last 12 calendar months, one point per month (summed)
 */
export type RevenuePoint = { day: string; revenueCents: number };
export type RevenueRange = "mois" | "trimestre" | "annee";
export type RevenueBucket = { label: string; value: number };

const MONTHS_FR = [
  "janv.", "févr.", "mars", "avr.", "mai", "juin",
  "juil.", "août", "sept.", "oct.", "nov.", "déc.",
] as const;

export function bucketRevenueSeries(
  series: readonly RevenuePoint[],
  range: RevenueRange,
): RevenueBucket[] {
  if (range === "mois") {
    return series.slice(-30).map((d) => ({ label: d.day.slice(8, 10), value: d.revenueCents }));
  }
  if (range === "trimestre") {
    const last = series.slice(-91);
    const out: RevenueBucket[] = [];
    for (let i = 0; i < last.length; i += 7) {
      const wk = last.slice(i, i + 7);
      if (wk.length === 0) continue;
      out.push({
        label: `${wk[0].day.slice(8, 10)}/${wk[0].day.slice(5, 7)}`,
        value: wk.reduce((s, d) => s + d.revenueCents, 0),
      });
    }
    return out;
  }
  // annee — sum by calendar month, keeping chronological order, then keep the
  // 12 MOST RECENT months: the current (month-to-date) one + the 11 before it.
  // A rolling day window (e.g. 365 rows) straddles 13 month keys — a sliver of
  // the same month a year ago would show up as a second, near-empty « sept. »
  // that reads like a collapse. The caller feeds ≥ ANNUAL_SERIES_DAYS rows so
  // the oldest kept month is always complete.
  const order: string[] = [];
  const byMonth = new Map<string, number>();
  for (const d of series) {
    const key = d.day.slice(0, 7); // YYYY-MM
    if (!byMonth.has(key)) order.push(key);
    byMonth.set(key, (byMonth.get(key) ?? 0) + d.revenueCents);
  }
  return order.slice(-12).map((key) => ({
    label: MONTHS_FR[Number(key.slice(5, 7)) - 1] ?? key,
    value: byMonth.get(key) ?? 0,
  }));
}

/**
 * Daily rows the dashboard must fetch so the « Année » bucket covers 12 FULL
 * calendar months: from the 1st of (current month − 11) through today spans at
 * most 366 days (a 31-day current month + a leap February in the window), so
 * 366 always reaches back to that 1st. The extra leading days fall in a 13th
 * month key, which `bucketRevenueSeries` drops.
 */
export const ANNUAL_SERIES_DAYS = 366;
