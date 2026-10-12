/**
 * Pure performance-config resolver + breach evaluator
 * (src/lib/telemetry/perf-config.ts). No DB, no server-only — runs under
 * `tsx --conditions=react-server`.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/perf-config.test.ts
 */
import {
  resolvePerformanceConfig,
  parseRecipients,
  evaluateBreaches,
  thresholdsOf,
  decideAlertTransitions,
  PERF_DEFAULTS,
  type PerfThresholds,
  type AlertState,
  type Breach,
  type BreachMetric,
} from "@/lib/telemetry/perf-config";

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

function main() {
  console.log("resolvePerformanceConfig — defaults:");
  const def = resolvePerformanceConfig({});
  check("empty map → defaults", JSON.stringify(def) === JSON.stringify(PERF_DEFAULTS));
  check("sampling on by default (fail-open)", def.samplingEnabled === true);
  check("alert email off by default (fail-closed)", def.alertEmailEnabled === false);
  check("recipients empty by default", def.alertRecipients.length === 0);

  console.log("resolvePerformanceConfig — blank/garbage → fallback:");
  const blank = resolvePerformanceConfig({
    "perf.sample_interval_sec": "",
    "perf.ram_warn_pct": "abc",
    "perf.cpu_warn_pct": "   ",
  });
  check("blank interval → default 10", blank.sampleIntervalSec === 10);
  check("garbage ram pct → default 85", blank.ramWarnPct === 85);
  check("whitespace cpu pct → default 90", blank.cpuWarnPct === 90);

  console.log("resolvePerformanceConfig — clamps:");
  const lo = resolvePerformanceConfig({
    "perf.sample_interval_sec": "1",
    "perf.history_size": "10",
    "perf.heartbeat_interval_sec": "1",
    "perf.ram_warn_pct": "0",
    "perf.cpu_warn_pct": "5",
    "perf.event_loop_lag_warn_ms": "1",
    "perf.db_latency_warn_ms": "1",
    "perf.alert_cooldown_min": "0",
    "perf.alert_breaches_required": "0",
  });
  check("interval clamps up to 5", lo.sampleIntervalSec === 5);
  check("history clamps up to 60", lo.historySize === 60);
  check("heartbeat clamps up to 30", lo.heartbeatIntervalSec === 30);
  check("ram pct clamps up to 50", lo.ramWarnPct === 50);
  check("cpu pct clamps up to 50", lo.cpuWarnPct === 50);
  check("event-loop lag clamps up to 20", lo.eventLoopLagWarnMs === 20);
  check("db latency clamps up to 50", lo.dbLatencyWarnMs === 50);
  check("cooldown clamps up to 5", lo.alertCooldownMin === 5);
  check("breaches-required clamps up to 1", lo.alertBreachesRequired === 1);

  const hi = resolvePerformanceConfig({
    "perf.sample_interval_sec": "99999",
    "perf.history_size": "99999",
    "perf.heartbeat_interval_sec": "99999",
    "perf.ram_warn_pct": "100",
    "perf.cpu_warn_pct": "999",
    "perf.event_loop_lag_warn_ms": "99999",
    "perf.db_latency_warn_ms": "99999",
    "perf.alert_cooldown_min": "99999",
    "perf.alert_breaches_required": "99",
  });
  check("interval clamps down to 300", hi.sampleIntervalSec === 300);
  check("history clamps down to 1440", hi.historySize === 1440);
  check("heartbeat clamps down to 3600", hi.heartbeatIntervalSec === 3600);
  check("ram pct clamps down to 99", hi.ramWarnPct === 99);
  check("cpu pct clamps down to 100", hi.cpuWarnPct === 100);
  check("event-loop lag clamps down to 2000", hi.eventLoopLagWarnMs === 2000);
  check("db latency clamps down to 5000", hi.dbLatencyWarnMs === 5000);
  check("cooldown clamps down to 1440", hi.alertCooldownMin === 1440);
  check("breaches-required clamps down to 10", hi.alertBreachesRequired === 10);

  console.log("resolvePerformanceConfig — bool coercion:");
  check("sampling '0' → false", resolvePerformanceConfig({ "perf.sampling_enabled": "0" }).samplingEnabled === false);
  check("sampling 'no' → false", resolvePerformanceConfig({ "perf.sampling_enabled": "no" }).samplingEnabled === false);
  check("alert email 'on' → true", resolvePerformanceConfig({ "perf.alert_email_enabled": "on" }).alertEmailEnabled === true);
  check("alert email 'yes' → true", resolvePerformanceConfig({ "perf.alert_email_enabled": "yes" }).alertEmailEnabled === true);

  console.log("parseRecipients:");
  check("null → []", parseRecipients(null).length === 0);
  check("comma split + trim", JSON.stringify(parseRecipients("a@x.tn, b@y.tn")) === JSON.stringify(["a@x.tn", "b@y.tn"]));
  check("semicolon + whitespace split", parseRecipients("a@x.tn; b@y.tn\nc@z.tn").length === 3);
  check("lowercased", parseRecipients("A@X.TN")[0] === "a@x.tn");
  check("invalid dropped", JSON.stringify(parseRecipients("ok@x.tn, not-an-email, also bad")) === JSON.stringify(["ok@x.tn"]));
  check("deduped", parseRecipients("a@x.tn, a@x.tn").length === 1);
  const many = Array.from({ length: 30 }, (_, i) => `u${i}@x.tn`).join(",");
  check("capped at 20", parseRecipients(many).length === 20);
  check("resolver wires parseRecipients", JSON.stringify(resolvePerformanceConfig({ "perf.alert_recipients": "ops@x.tn, ops@x.tn" }).alertRecipients) === JSON.stringify(["ops@x.tn"]));

  console.log("evaluateBreaches:");
  const t: PerfThresholds = { ramWarnPct: 85, cpuWarnPct: 90, eventLoopLagWarnMs: 200, dbLatencyWarnMs: 500 };
  const healthy = { ramPct: 40, cpuPct: 30, eventLoopLagMs: 12, dbLatencyMs: 20, dbOk: true };
  check("healthy → no breaches", evaluateBreaches(healthy, t).length === 0);

  const ramHot = evaluateBreaches({ ...healthy, ramPct: 90 }, t);
  check("ram over → ram breach", ramHot.length === 1 && ramHot[0].metric === "ram");
  check("ram breach carries value+threshold", ramHot[0].value === 90 && ramHot[0].threshold === 85);

  check("ram AT threshold (>=) → breach", evaluateBreaches({ ...healthy, ramPct: 85 }, t).some((b) => b.metric === "ram"));
  check("ram just under → no breach", !evaluateBreaches({ ...healthy, ramPct: 84.9 }, t).some((b) => b.metric === "ram"));

  check("cpu over → cpu breach", evaluateBreaches({ ...healthy, cpuPct: 95 }, t).some((b) => b.metric === "cpu"));
  check("event-loop over → event_loop breach", evaluateBreaches({ ...healthy, eventLoopLagMs: 250 }, t).some((b) => b.metric === "event_loop"));
  check("db latency over → db_latency breach", evaluateBreaches({ ...healthy, dbLatencyMs: 600 }, t).some((b) => b.metric === "db_latency"));

  const down = evaluateBreaches({ ...healthy, dbOk: false, dbLatencyMs: null }, t);
  check("dbOk false → db_down breach", down.some((b) => b.metric === "db_down"));
  check("db_down suppresses db_latency", !down.some((b) => b.metric === "db_latency"));

  check("null measurement → no breach", evaluateBreaches({ ramPct: null, cpuPct: null, eventLoopLagMs: null, dbLatencyMs: null, dbOk: true }, t).length === 0);

  const multi = evaluateBreaches({ ramPct: 99, cpuPct: 99, eventLoopLagMs: 999, dbLatencyMs: 999, dbOk: true }, t);
  check("multiple breaches reported together", multi.length === 4);

  console.log("thresholdsOf:");
  const th = thresholdsOf(def);
  check("extracts the 4 thresholds", th.ramWarnPct === 85 && th.cpuWarnPct === 90 && th.eventLoopLagWarnMs === 200 && th.dbLatencyWarnMs === 500);

  console.log("decideAlertTransitions — debounce / cooldown / recovery:");
  const empty = (): AlertState => ({ streak: {}, lastAlertAt: {}, active: [] });
  const ramBreach: Breach = { metric: "ram", value: 99, threshold: 85 };
  const cpuBreach: Breach = { metric: "cpu", value: 99, threshold: 90 };
  const cfg2 = { alertBreachesRequired: 2, alertCooldownMin: 30 }; // cooldown = 1.8e6 ms
  const T0 = 1_000_000_000_000;

  // 1) First breaching tick: streak builds but does not yet reach the required 2.
  const d1 = decideAlertTransitions([ramBreach], empty(), cfg2, T0);
  check("streak below required → no raise", d1.raise.length === 0);
  check("streak below required → not active", d1.next.active.length === 0);
  check("streak counted (1)", d1.next.streak.ram === 1);

  // 2) Second consecutive breaching tick reaches the required count → raise + active.
  const d2 = decideAlertTransitions([ramBreach], d1.next, cfg2, T0 + 10_000);
  check("reaching required → raise", d2.raise.length === 1 && d2.raise[0].metric === "ram");
  check("reaching required → active", d2.next.active.includes("ram"));
  check("lastAlertAt stamped", d2.next.lastAlertAt.ram === T0 + 10_000);

  // 3) Still breaching but inside the cooldown window → no repeat raise (anti-spam).
  const d3 = decideAlertTransitions([ramBreach], d2.next, cfg2, T0 + 20_000);
  check("within cooldown → no re-raise", d3.raise.length === 0);
  check("within cooldown → stays active", d3.next.active.includes("ram"));

  // 4) After the cooldown elapses, a continuing breach re-raises.
  const d4 = decideAlertTransitions([ramBreach], d3.next, cfg2, T0 + 10_000 + 1_800_001);
  check("after cooldown → re-raise", d4.raise.length === 1 && d4.raise[0].metric === "ram");

  // 5) Recovery: previously-active metric stops breaching → single recovery + cleared.
  const d5 = decideAlertTransitions([], d4.next, cfg2, T0 + 5_000_000);
  check("recovery → recover emitted", d5.recover.includes("ram"));
  check("recovery → active cleared", !d5.next.active.includes("ram"));
  check("recovery → streak reset", d5.next.streak.ram === 0);

  // 6) Non-breach with no prior active episode → nothing happens.
  const d6 = decideAlertTransitions([], empty(), cfg2, T0);
  check("no active + no breach → no recover", d6.recover.length === 0 && d6.raise.length === 0);

  // 7) Metrics are independent: ram can raise while cpu is still building its streak.
  const s7a = decideAlertTransitions([ramBreach, cpuBreach], empty(), cfg2, T0);
  const s7b = decideAlertTransitions([ramBreach, cpuBreach], s7a.next, cfg2, T0 + 1000);
  check("multi-metric independence (both raise at required)", s7b.raise.length === 2);
  check("ram does not steal cpu's streak", s7a.next.streak.cpu === 1 && s7a.next.streak.ram === 1);

  // 8) required=1 fires on the very first breaching tick.
  const d8 = decideAlertTransitions([ramBreach], empty(), { alertBreachesRequired: 1, alertCooldownMin: 30 }, T0);
  check("required=1 → immediate raise", d8.raise.length === 1);

  // 9) Input does not mutate the previous state (reducer returns a fresh state).
  const prev9 = empty();
  decideAlertTransitions([ramBreach], prev9, cfg2, T0);
  check("prev state not mutated", prev9.streak.ram === undefined && prev9.active.length === 0);

  console.log("decideAlertTransitions — badge truthfulness / recovery / boundary / DB metrics:");

  // 10) Badge reflects reality: once debounce is met the metric is active EVEN IF
  //     the notification is cooldown-suppressed (regression guard for the badge
  //     desync — `active` must never lie about a live breach).
  const prevCooling: AlertState = { streak: { ram: 2 }, lastAlertAt: { ram: T0 }, active: [] };
  const d10 = decideAlertTransitions([ramBreach], prevCooling, cfg2, T0 + 1000);
  check("debounced breach within cooldown → no raise", d10.raise.length === 0);
  check("debounced breach within cooldown → STILL active (badge truthful)", d10.next.active.includes("ram"));

  // 11) Recovery clears the cooldown clock → a DISTINCT later episode (even inside
  //     the original cooldown window) alerts immediately rather than being
  //     swallowed by the recovered episode's stale cooldown.
  const cfg1 = { alertBreachesRequired: 1, alertCooldownMin: 30 };
  const r11a = decideAlertTransitions([ramBreach], empty(), cfg1, T0);
  check("episode A raises", r11a.raise.length === 1 && r11a.next.active.includes("ram"));
  const r11b = decideAlertTransitions([], r11a.next, cfg1, T0 + 1000);
  check("episode A recovers", r11b.recover.includes("ram"));
  check("recovery clears the cooldown clock", r11b.next.lastAlertAt.ram === undefined);
  const r11c = decideAlertTransitions([ramBreach], r11b.next, cfg1, T0 + 2000);
  check("distinct episode after recovery re-raises immediately", r11c.raise.length === 1);
  check("distinct episode after recovery re-activates", r11c.next.active.includes("ram"));

  // 12) Cooldown boundary is strict-less-than (`nowMs - last < cooldownMs`): at
  //     exactly cooldownMs it MUST raise; one ms before it must NOT.
  const cooldownMs = 30 * 60_000;
  const prevBoundary = (): AlertState => ({ streak: { ram: 2 }, lastAlertAt: { ram: T0 }, active: ["ram"] });
  check(
    "exact cooldown boundary (== cooldownMs) → re-raise",
    decideAlertTransitions([ramBreach], prevBoundary(), cfg2, T0 + cooldownMs).raise.length === 1,
  );
  check(
    "one ms before cooldown boundary → no re-raise",
    decideAlertTransitions([ramBreach], prevBoundary(), cfg2, T0 + cooldownMs - 1).raise.length === 0,
  );

  // 13) DB metrics through the reducer: db_down raises with null value/threshold,
  //     then "DB back-but-slow" recovers db_down while db_latency raises same tick.
  const dbDown: Breach = { metric: "db_down", value: null, threshold: null };
  const dbLat: Breach = { metric: "db_latency", value: 900, threshold: 500 };
  const r13a = decideAlertTransitions([dbDown], empty(), cfg1, T0);
  check("db_down raises", r13a.raise.length === 1 && r13a.raise[0].metric === "db_down");
  check("db_down raise carries null value+threshold", r13a.raise[0].value === null && r13a.raise[0].threshold === null);
  check("db_down active", r13a.next.active.includes("db_down" as BreachMetric));
  const r13b = decideAlertTransitions([dbLat], r13a.next, cfg1, T0 + 1000);
  check("DB back-but-slow: db_latency raises", r13b.raise.some((b) => b.metric === "db_latency"));
  check("DB back-but-slow: db_down recovers same tick", r13b.recover.includes("db_down" as BreachMetric));
  check(
    "DB back-but-slow: active is exactly [db_latency]",
    r13b.next.active.length === 1 && r13b.next.active[0] === "db_latency",
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
