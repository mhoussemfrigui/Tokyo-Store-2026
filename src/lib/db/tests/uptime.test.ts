/**
 * Pure uptime/downtime computation from the heartbeat trail
 * (src/lib/telemetry/uptime.ts). No DB, no server-only.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/uptime.test.ts
 */
import { computeUptimeStats, type HeartbeatLike } from "@/lib/telemetry/uptime";

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

const NOW = 1_700_000_000_000;
const H = 3_600_000;
const MIN = 60_000;
const windowStartMs = NOW - 24 * H;
const opts = { heartbeatIntervalSec: 60, windowStartMs, nowMs: NOW }; // grace = 120s

function main() {
  console.log("computeUptimeStats — empty:");
  const empty = computeUptimeStats([], opts);
  check("no rows → 0 instances", empty.instances === 0);
  check("no rows → 0 restarts", empty.restarts === 0);
  check("no rows → 0 downtime", empty.downtimeMs === 0);
  check("no rows → 100% availability", empty.availabilityPct === 100);
  check("no rows → null lastRestartAt", empty.lastRestartAt === null);

  console.log("computeUptimeStats — single continuous instance:");
  const one: HeartbeatLike[] = [
    { startedAt: NOW - 23 * H, lastSeenAt: NOW - MIN, stoppedAt: null },
  ];
  const r1 = computeUptimeStats(one, opts);
  check("1 instance", r1.instances === 1);
  check("0 restarts", r1.restarts === 0);
  check("no downtime (still alive)", r1.downtimeMs === 0);
  check("lastRestartAt = its start", r1.lastRestartAt === NOW - 23 * H);

  console.log("computeUptimeStats — big gap between two instances → downtime:");
  const gap: HeartbeatLike[] = [
    { startedAt: NOW - 10 * H, lastSeenAt: NOW - 9 * H, stoppedAt: null },
    { startedAt: NOW - 1 * H, lastSeenAt: NOW - MIN, stoppedAt: null },
  ];
  const r2 = computeUptimeStats(gap, opts);
  check("2 instances", r2.instances === 2);
  check("1 restart", r2.restarts === 1);
  check("one gap detected", r2.gaps.length === 1);
  check("downtime ≈ 8h", r2.downtimeMs === 8 * H);
  check("availability < 100", r2.availabilityPct < 100);

  console.log("computeUptimeStats — clean stop then restart measures from stopped_at:");
  const clean: HeartbeatLike[] = [
    { startedAt: NOW - 10 * H, lastSeenAt: NOW - 9 * H - 30 * MIN, stoppedAt: NOW - 9 * H },
    { startedAt: NOW - 1 * H, lastSeenAt: NOW - MIN, stoppedAt: null },
  ];
  const r3 = computeUptimeStats(clean, opts);
  check("gap measured from stopped_at (8h)", r3.downtimeMs === 8 * H);

  console.log("computeUptimeStats — small gap (< grace) is NOT downtime:");
  const small: HeartbeatLike[] = [
    { startedAt: NOW - 3 * H, lastSeenAt: NOW - 2 * H, stoppedAt: NOW - 2 * H },
    { startedAt: NOW - 2 * H + 60_000, lastSeenAt: NOW - MIN, stoppedAt: null },
  ];
  const r4 = computeUptimeStats(small, opts);
  check("no downtime for a sub-grace gap", r4.downtimeMs === 0);
  check("still counts as a restart", r4.restarts === 1);

  console.log("computeUptimeStats — trailing silence → downtime to now:");
  const silent: HeartbeatLike[] = [
    { startedAt: NOW - 5 * H, lastSeenAt: NOW - 3 * H, stoppedAt: null },
  ];
  const r5 = computeUptimeStats(silent, opts);
  check("trailing silence counted", r5.downtimeMs === 3 * H);
  check("one trailing gap", r5.gaps.length === 1);

  console.log("computeUptimeStats — unsorted input is sorted internally:");
  const unsorted: HeartbeatLike[] = [
    { startedAt: NOW - 1 * H, lastSeenAt: NOW - MIN, stoppedAt: null },
    { startedAt: NOW - 10 * H, lastSeenAt: NOW - 9 * H, stoppedAt: null },
  ];
  const r6 = computeUptimeStats(unsorted, opts);
  check("downtime same as sorted (8h)", r6.downtimeMs === 8 * H);
  check("lastRestartAt = newest start", r6.lastRestartAt === NOW - 1 * H);

  // ── Overlapping instances (replicas / rolling redeploy): downtime is the
  // complement of the UNION of coverage, not neighbour-to-neighbour gaps.
  console.log("computeUptimeStats — overlapping instances → no invented gap:");
  const overlap: HeartbeatLike[] = [
    { startedAt: NOW - 20 * H, lastSeenAt: NOW - MIN, stoppedAt: null }, // long-lived, serving
    { startedAt: NOW - 10 * H, lastSeenAt: NOW - 9 * H, stoppedAt: null }, // short-lived
    { startedAt: NOW - 2 * H, lastSeenAt: NOW - MIN, stoppedAt: null }, // later boot
  ];
  const r7 = computeUptimeStats(overlap, opts);
  check("no downtime while the long-lived instance covered the gap", r7.downtimeMs === 0);
  check("no gaps", r7.gaps.length === 0);
  check("100% availability", r7.availabilityPct === 100);
  check("3 instances, 2 restarts", r7.instances === 3 && r7.restarts === 2);

  console.log("computeUptimeStats — trailing check uses the LATEST end, not the newest boot:");
  const newestSilent: HeartbeatLike[] = [
    { startedAt: NOW - 20 * H, lastSeenAt: NOW - MIN, stoppedAt: null }, // still alive
    { startedAt: NOW - 2 * H, lastSeenAt: NOW - 1 * H, stoppedAt: null }, // newest boot, silent
  ];
  const r8 = computeUptimeStats(newestSilent, opts);
  check("no trailing downtime while another instance is alive", r8.downtimeMs === 0);

  console.log("computeUptimeStats — overlapping union followed by a real outage:");
  const unionGap: HeartbeatLike[] = [
    { startedAt: NOW - 20 * H, lastSeenAt: NOW - 8 * H, stoppedAt: null },
    { startedAt: NOW - 12 * H, lastSeenAt: NOW - 6 * H, stoppedAt: null }, // extends coverage
    { startedAt: NOW - 3 * H, lastSeenAt: NOW - MIN, stoppedAt: null },
  ];
  const r9 = computeUptimeStats(unionGap, opts);
  check("gap measured from the union end (−6h) to the next boot (−3h)", r9.downtimeMs === 3 * H);
  check("exactly one gap", r9.gaps.length === 1 && r9.gaps[0].fromMs === NOW - 6 * H);

  // ── Instances booted BEFORE the window (the recent() overlap fetch returns them).
  console.log("computeUptimeStats — instance booted before the window, died inside it:");
  const carried: HeartbeatLike[] = [
    { startedAt: windowStartMs - 16 * H, lastSeenAt: NOW - 5 * H, stoppedAt: null },
    { startedAt: NOW - 2 * H, lastSeenAt: NOW - MIN, stoppedAt: null },
  ];
  const r10 = computeUptimeStats(carried, opts);
  check("outage counted (−5h → −2h = 3h)", r10.downtimeMs === 3 * H);
  check("availability < 100", r10.availabilityPct < 100);
  check("2 instances", r10.instances === 2);
  check("the in-window boot after a carried-over instance is 1 restart", r10.restarts === 1);

  console.log("computeUptimeStats — single instance running since before the window:");
  const longRunning: HeartbeatLike[] = [
    { startedAt: windowStartMs - 40 * H, lastSeenAt: NOW - MIN, stoppedAt: null },
  ];
  const r11 = computeUptimeStats(longRunning, opts);
  check("0 restarts", r11.restarts === 0);
  check("no downtime", r11.downtimeMs === 0 && r11.availabilityPct === 100);
  check("lastRestartAt = its (pre-window) boot", r11.lastRestartAt === windowStartMs - 40 * H);

  console.log("computeUptimeStats — carried-over instance went silent, nothing replaced it:");
  const carriedDead: HeartbeatLike[] = [
    { startedAt: windowStartMs - 40 * H, lastSeenAt: NOW - 4 * H, stoppedAt: null },
  ];
  const r12 = computeUptimeStats(carriedDead, opts);
  check("trailing silence counted (4h)", r12.downtimeMs === 4 * H);
  check("0 restarts", r12.restarts === 0);

  console.log("computeUptimeStats — two in-window boots after a carried-over instance:");
  const carriedTwo: HeartbeatLike[] = [
    { startedAt: windowStartMs - 5 * H, lastSeenAt: NOW - 10 * H, stoppedAt: NOW - 10 * H },
    { startedAt: NOW - 10 * H + MIN, lastSeenAt: NOW - 4 * H, stoppedAt: NOW - 4 * H },
    { startedAt: NOW - 4 * H + MIN, lastSeenAt: NOW - MIN, stoppedAt: null },
  ];
  const r13 = computeUptimeStats(carriedTwo, opts);
  check("2 restarts", r13.restarts === 2);
  check("sub-grace redeploy gaps are not downtime", r13.downtimeMs === 0);

  console.log("computeUptimeStats — a gap straddling the window start is clamped:");
  const straddle: HeartbeatLike[] = [
    { startedAt: windowStartMs - 10 * H, lastSeenAt: windowStartMs - 1 * H, stoppedAt: null },
    { startedAt: windowStartMs + 2 * H, lastSeenAt: NOW - MIN, stoppedAt: null },
  ];
  const r14 = computeUptimeStats(straddle, opts);
  check("only the in-window part (2h) counts", r14.downtimeMs === 2 * H);
  check("gap starts at the window edge", r14.gaps[0]?.fromMs === windowStartMs);

  console.log("computeUptimeStats — a clean stop stamped after the last beat ends coverage there:");
  const stopAfterBeat: HeartbeatLike[] = [
    { startedAt: NOW - 10 * H, lastSeenAt: NOW - 9 * H - MIN, stoppedAt: NOW - 9 * H },
    { startedAt: NOW - 9 * H + 30_000, lastSeenAt: NOW - MIN, stoppedAt: null },
  ];
  check(
    "stop → next boot within grace is not downtime",
    computeUptimeStats(stopAfterBeat, opts).downtimeMs === 0,
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
