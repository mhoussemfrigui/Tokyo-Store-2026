/**
 * Pure unit tests for the dashboard revenue-chart bucketing — NO database.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/revenue-buckets.test.ts
 */
import {
  ANNUAL_SERIES_DAYS,
  bucketRevenueSeries,
  type RevenuePoint,
} from "@/lib/analytics/revenue-buckets";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}
function eq(label: string, got: unknown, want: unknown) {
  check(
    `${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`,
    JSON.stringify(got) === JSON.stringify(want),
  );
}

const mk = (day: string, revenueCents: number): RevenuePoint => ({ day, revenueCents });

console.log("revenue-chart bucketing:");

// ── empty series → empty buckets for every range (no throw) ──────────────────
eq("mois empty", bucketRevenueSeries([], "mois"), []);
eq("trimestre empty", bucketRevenueSeries([], "trimestre"), []);
eq("annee empty", bucketRevenueSeries([], "annee"), []);

// ── mois: one point per day, day-of-month label, value passthrough ───────────
{
  const s = [mk("2026-03-01", 100), mk("2026-03-02", 200), mk("2026-03-09", 300)];
  eq("mois maps daily", bucketRevenueSeries(s, "mois"), [
    { label: "01", value: 100 },
    { label: "02", value: 200 },
    { label: "09", value: 300 },
  ]);
}
{
  // keeps only the last 30 days (31-day input → 30 buckets, drops the oldest)
  const s = Array.from({ length: 31 }, (_, i) =>
    mk(`2026-01-${String(i + 1).padStart(2, "0")}`, i),
  );
  const out = bucketRevenueSeries(s, "mois");
  eq("mois caps at 30 points", out.length, 30);
  eq("mois drops the oldest day", out[0], { label: "02", value: 1 });
}

// ── trimestre: 7-day buckets, revenue summed, day/month label ────────────────
{
  const s = Array.from({ length: 14 }, (_, i) =>
    mk(`2026-04-${String(i + 1).padStart(2, "0")}`, 10),
  );
  eq("trimestre 2 full weeks", bucketRevenueSeries(s, "trimestre"), [
    { label: "01/04", value: 70 },
    { label: "08/04", value: 70 },
  ]);
}
{
  // partial trailing week (10 days → 7 + 3)
  const s = Array.from({ length: 10 }, (_, i) =>
    mk(`2026-04-${String(i + 1).padStart(2, "0")}`, 5),
  );
  eq("trimestre partial last week", bucketRevenueSeries(s, "trimestre"), [
    { label: "01/04", value: 35 },
    { label: "08/04", value: 15 },
  ]);
}

// ── annee: sum by calendar month, chronological order, French label ──────────
{
  const s = [
    mk("2026-01-15", 100),
    mk("2026-01-20", 200),
    mk("2026-02-10", 50),
    mk("2026-04-01", 7),
  ];
  eq("annee groups by month", bucketRevenueSeries(s, "annee"), [
    { label: "janv.", value: 300 },
    { label: "févr.", value: 50 },
    { label: "avr.", value: 7 },
  ]);
}
{
  // single point still buckets cleanly in every range
  const s = [mk("2026-12-25", 999)];
  eq("single point — mois", bucketRevenueSeries(s, "mois"), [{ label: "25", value: 999 }]);
  eq("single point — annee", bucketRevenueSeries(s, "annee"), [{ label: "déc.", value: 999 }]);
}

// ── annee on a DENSE rolling window (what getDailyOrdersSeries returns) ──────
/** `n` consecutive 0-filled-style daily rows ending on `endIso`, 1 cent/day. */
function denseSeries(endIso: string, n: number): RevenuePoint[] {
  const end = Date.parse(`${endIso}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) =>
    mk(new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10), 1),
  );
}
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12
{
  // 365 rows ending 2026-09-23 start 2025-09-24 → 13 month keys (two « sept. »).
  const out = bucketRevenueSeries(denseSeries("2026-09-23", 365), "annee");
  eq("annee dense 365 → exactly 12 buckets", out.length, 12);
  eq("annee labels are unique (no second « sept. »)", new Set(out.map((b) => b.label)).size, 12);
  eq("annee starts at the month AFTER the partial one", out[0].label, "oct.");
  eq("annee ends on the current month-to-date", out[11], { label: "sept.", value: 23 });
  eq("annee first bucket is a FULL month (31 days of oct.)", out[0].value, 31);
}
{
  // ANNUAL_SERIES_DAYS always reaches the 1st of (month − 11): every kept month
  // except the current one is complete, incl. a leap-February window.
  for (const end of ["2026-09-23", "2025-01-31", "2024-03-31", "2026-12-31", "2027-02-28"]) {
    const out = bucketRevenueSeries(denseSeries(end, ANNUAL_SERIES_DAYS), "annee");
    const [y, m] = end.split("-").map(Number);
    const fullMonthsOk = out.slice(0, 11).every((b, i) => {
      const mm = ((m - 11 + i - 1 + 24) % 12) + 1;
      const yy = y + Math.floor((m - 11 + i - 1) / 12);
      return b.value === daysIn(yy, mm);
    });
    check(`annee @${end}: 12 buckets, 11 full months + month-to-date`, out.length === 12 && fullMonthsOk);
  }
}

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
