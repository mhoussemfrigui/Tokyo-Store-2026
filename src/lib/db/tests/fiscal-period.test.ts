/**
 * fiscalYear — the per-year bucket for GAPLESS document numbering (invoices,
 * credit notes, delivery notes). Must bucket on the STORE timezone
 * (Africa/Tunis, UTC+1), not the UTC server clock, or a document issued in the
 * first hour of Jan 1 local time (still Dec 31 UTC) lands in the wrong year's
 * sequence. Pure, no DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/fiscal-period.test.ts
 */
import { fiscalYear } from "@/lib/fiscal-period";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

function main() {
  // 2025-12-31 23:30 UTC = 2026-01-01 00:30 Tunis → fiscal year 2026.
  check("Dec-31 23:30 UTC → 2026 (Tunis has rolled over)", fiscalYear(new Date("2025-12-31T23:30:00Z")) === "2026");
  // 2026-01-01 00:30 UTC = 01:30 Tunis, same day → 2026.
  check("Jan-01 00:30 UTC → 2026", fiscalYear(new Date("2026-01-01T00:30:00Z")) === "2026");
  // 2026-12-31 12:00 UTC = 13:00 Tunis, still 2026.
  check("mid-day Dec-31 → 2026", fiscalYear(new Date("2026-12-31T12:00:00Z")) === "2026");
  // Just before Tunis new year: 2026-12-31 22:30 UTC = 23:30 Tunis → still 2026.
  check("Dec-31 22:30 UTC → 2026 (Tunis not yet rolled)", fiscalYear(new Date("2026-12-31T22:30:00Z")) === "2026");
  // At Tunis new year: 2026-12-31 23:00 UTC = 2027-01-01 00:00 Tunis → 2027.
  check("Dec-31 23:00 UTC → 2027 (Tunis midnight)", fiscalYear(new Date("2026-12-31T23:00:00Z")) === "2027");

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
