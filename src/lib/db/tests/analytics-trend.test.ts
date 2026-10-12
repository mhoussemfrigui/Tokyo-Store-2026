/**
 * Pure unit tests for the admin analytics trend helpers — NO database.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/analytics-trend.test.ts
 */
import { aovCents, computeDelta, sharePct, splitWindow, sumBy } from "@/lib/analytics/trend";

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
  check(`${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, JSON.stringify(got) === JSON.stringify(want));
}

console.log("analytics trend helpers:");

// ── computeDelta ────────────────────────────────────────────────────────────
{
  const d = computeDelta(150, 100);
  eq("growth pct", d.pct, 50);
  eq("growth direction", d.direction, "up");
  eq("growth absolute", d.absolute, 50);
}
{
  const d = computeDelta(80, 100);
  eq("decline pct", d.pct, -20);
  eq("decline direction", d.direction, "down");
}
{
  const d = computeDelta(100, 100);
  eq("flat pct", d.pct, 0);
  eq("flat direction", d.direction, "flat");
}
{
  const d = computeDelta(50, 0);
  eq("no-baseline pct is null", d.pct, null);
  eq("no-baseline direction up", d.direction, "up");
}
{
  const d = computeDelta(0, 0);
  eq("empty→empty pct is 0 (not null)", d.pct, 0);
  eq("empty→empty direction flat", d.direction, "flat");
}
{
  const d = computeDelta(Number.NaN, Number.POSITIVE_INFINITY);
  eq("non-finite coerced to 0/0", [d.current, d.previous, d.pct], [0, 0, 0]);
}
// rounding: 1→3 = +200%, 3→1 = -67% (rounded)
eq("rounds 3→1 to -67%", computeDelta(1, 3).pct, -67);

// ── sumBy ───────────────────────────────────────────────────────────────────
eq("sumBy empty", sumBy([], (r: { n: number }) => r.n), 0);
eq("sumBy values", sumBy([{ n: 2 }, { n: 3 }, { n: 5 }], (r) => r.n), 10);
eq("sumBy skips non-finite", sumBy([{ n: 2 }, { n: Number.NaN }, { n: 5 }], (r) => r.n), 7);

// ── splitWindow ───────────────────────────────────────────────────────────────
{
  const series = [1, 2, 3, 4, 5, 6]; // 2×window of 3
  const { previous, current } = splitWindow(series, 3);
  eq("split previous half", previous, [1, 2, 3]);
  eq("split current half", current, [4, 5, 6]);
}
{
  // longer than 2×window → takes the latest two windows
  const series = [9, 9, 1, 2, 3, 4]; // window 2 → prev [2,3]? no: last 2 = [3,4], prev 2 = [1,2]
  const { previous, current } = splitWindow(series, 2);
  eq("split long current=last window", current, [3, 4]);
  eq("split long previous=window before", previous, [1, 2]);
}
{
  // shorter than window → current = whole, previous = empty (no throw)
  const { previous, current } = splitWindow([1, 2], 5);
  eq("split short current", current, [1, 2]);
  eq("split short previous empty", previous, []);
}

// ── aovCents ──────────────────────────────────────────────────────────────────
eq("aov normal", aovCents(10000, 4), 2500);
eq("aov zero orders → 0", aovCents(10000, 0), 0);
eq("aov rounds", aovCents(1000, 3), 333);

// ── sharePct ──────────────────────────────────────────────────────────────────
eq("share normal", sharePct(25, 100), 25);
eq("share zero total → 0", sharePct(5, 0), 0);
eq("share rounds", sharePct(1, 3), 33);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
