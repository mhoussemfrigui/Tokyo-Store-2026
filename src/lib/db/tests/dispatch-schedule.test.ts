/**
 * Cron dispatch DUE-NESS — PURE unit test (no DB). Pins isJobDue / isDispatchable /
 * storeDailyInstantMs / nextDispatchAtMs so the single `/api/cron/dispatch` heartbeat
 * fires each job exactly on its cadence (interval slack + Africa/Tunis +01:00 daily).
 * Run: tsx --conditions=react-server src/lib/db/tests/dispatch-schedule.test.ts
 */
import { isDispatchable, isJobDue, nextDispatchAtMs, storeDailyInstantMs } from "@/lib/jobs/dispatch-schedule";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const now = Date.UTC(2026, 6, 16, 7, 0, 0); // store-local 08:00 (+01:00)
const MIN = 60_000;
const every12 = { mode: "interval", everyMinutes: 12 } as const;
const every2 = { mode: "interval", everyMinutes: 2 } as const;
const daily3 = { mode: "daily", atHour: 3, atMinute: 0 } as const;
const daily930 = { mode: "daily", atHour: 9, atMinute: 30 } as const;

// ── storeDailyInstantMs: store-local → absolute UTC ──
check("03:00 store-local today = 02:00Z", storeDailyInstantMs(now, 3, 0) === Date.UTC(2026, 6, 16, 2, 0, 0));
check("00:00 store-local today = prev-day 23:00Z", storeDailyInstantMs(now, 0, 0) === Date.UTC(2026, 6, 15, 23, 0, 0));

// ── interval ──
check("interval: never run → due", isJobDue(every12, null, now));
check("interval: 5 min ago → NOT due", !isJobDue(every12, now - 5 * MIN, now));
check("interval: exactly 12 min ago → due", isJobDue(every12, now - 12 * MIN, now));
check("interval: 13 min ago → due", isJobDue(every12, now - 13 * MIN, now));
check("interval slack: 1m40s ago (20s inside the 30s slack) → due", isJobDue(every2, now - (2 * MIN - 20_000), now));
check("interval slack: 1m20s ago (40s short, outside slack) → NOT due", !isJobDue(every2, now - (2 * MIN - 40_000), now));

// ── daily ──
check("daily(03:00): never run, time passed → due", isJobDue(daily3, null, now));
check("daily(03:00): already ran AFTER 03:00 today → NOT due", !isJobDue(daily3, Date.UTC(2026, 6, 16, 5, 0, 0), now));
check("daily(03:00): last run YESTERDAY → due", isJobDue(daily3, Date.UTC(2026, 6, 15, 5, 0, 0), now));
check("daily(09:30): time not arrived → NOT due (even if never run)", !isJobDue(daily930, null, now));

// ── opportunistic / internal never dispatched ──
check("opportunistic → never due", !isJobDue({ mode: "opportunistic" }, null, now));
check("internal → never due", !isJobDue({ mode: "internal" }, null, now));
check("isDispatchable: interval + daily yes", isDispatchable(every12) && isDispatchable(daily3));
check("isDispatchable: opportunistic + internal no", !isDispatchable({ mode: "opportunistic" }) && !isDispatchable({ mode: "internal" }));

// ── nextDispatchAtMs (the admin « Prochaine » column) ──
check("next: interval never-run → now", nextDispatchAtMs(every12, null, now) === now);
check("next: interval ran 5m ago → lastRun+12m−30s slack (earliest fire)", nextDispatchAtMs(every12, now - 5 * MIN, now) === now - 5 * MIN + 12 * MIN - 30_000);
check("next: interval OVERDUE (20m ago) → now (clamped)", nextDispatchAtMs(every12, now - 20 * MIN, now) === now);
check("next: daily(03:00) never-run + passed → now (due)", nextDispatchAtMs(daily3, null, now) === now);
check("next: daily(03:00) ran today → tomorrow 02:00Z", nextDispatchAtMs(daily3, Date.UTC(2026, 6, 16, 5, 0, 0), now) === Date.UTC(2026, 6, 17, 2, 0, 0));
check("next: daily(09:30) not arrived → today 08:30Z", nextDispatchAtMs(daily930, null, now) === Date.UTC(2026, 6, 16, 8, 30, 0));
check("next: opportunistic + internal → null", nextDispatchAtMs({ mode: "opportunistic" }, null, now) === null && nextDispatchAtMs({ mode: "internal" }, null, now) === null);

console.log(`\n=== dispatch-schedule: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
