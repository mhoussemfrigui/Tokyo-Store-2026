/**
 * PURE performance / runtime-monitoring config — NO "server-only", NO DB import,
 * so it can be unit-tested directly (mirrors src/lib/audit/parse-config.ts +
 * src/modules/search/parse-config.ts). The async loader is just
 * `getSettingsMap()` + `resolvePerformanceConfig(map)` (see perf-runtime-config.ts).
 *
 * All keys live under the `perf.` prefix and are RUNTIME-DEFAULTED (no seed
 * migration): an empty settings map yields the documented defaults below
 * (sampling on, 10s cadence, sane warn thresholds, alert email OFF/fail-closed).
 *
 * Two pure decision functions are exported so the alert subscriber and the admin
 * UI badges share ONE source of truth: `evaluateBreaches` (sample vs thresholds)
 * and `parseRecipients` (CSV → validated lowercase email list).
 */

import { asBool } from "@/lib/cms/setting-coerce";
import { parseEmailRecipients } from "@/lib/format/email-recipients";

/** The four live warn thresholds — the sub-shape `evaluateBreaches` needs. */
export type PerfThresholds = {
  /** RSS-vs-limit memory % at/above which a RAM breach fires. */
  ramWarnPct: number;
  /** Process CPU % (normalised by core count) at/above which a CPU breach fires. */
  cpuWarnPct: number;
  /** Event-loop p99 lag (ms) at/above which an event-loop breach fires. */
  eventLoopLagWarnMs: number;
  /** DB round-trip latency (ms) at/above which a DB-latency breach fires. */
  dbLatencyWarnMs: number;
};

export type PerfConfig = PerfThresholds & {
  /** Master sampler switch — false pauses the in-process sampler + heartbeat. */
  samplingEnabled: boolean;
  /** Seconds between sampler ticks (live gauges + breach evaluation). */
  sampleIntervalSec: number;
  /** Ring-buffer length kept in memory for the Historique view. */
  historySize: number;
  /** Seconds between DB heartbeat upserts (drives uptime/downtime tracking). */
  heartbeatIntervalSec: number;
  /** Whether a sustained breach also emails (it always emits a bus event). */
  alertEmailEnabled: boolean;
  /** Minutes to suppress a repeat alert for the same metric (anti-spam). */
  alertCooldownMin: number;
  /** Validated recipient list for breach emails (empty ⇒ fall back to admins). */
  alertRecipients: string[];
  /** Consecutive breaching samples required before an alert fires (debounce). */
  alertBreachesRequired: number;
};

export const PERF_DEFAULTS: PerfConfig = {
  samplingEnabled: true,
  sampleIntervalSec: 10,
  historySize: 360,
  heartbeatIntervalSec: 60,
  ramWarnPct: 85,
  cpuWarnPct: 90,
  eventLoopLagWarnMs: 200,
  dbLatencyWarnMs: 500,
  alertEmailEnabled: false,
  alertCooldownMin: 30,
  alertRecipients: [],
  alertBreachesRequired: 2,
};

/** Parse a textual number, falling back when absent / empty / non-finite. */
function num(v: string | null | undefined, fallback: number): number {
  if (v == null) return fallback;
  const t = v.trim();
  // Number("") is 0 (not NaN) — treat blank as "unset" so it uses the default.
  if (t === "") return fallback;
  const n = Number(t);
  return Number.isFinite(n) ? n : fallback;
}

const clampInt = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(Math.round(n), hi));

/**
 * Parse the `perf.alert_recipients` CSV into a deduped, lowercased, validated
 * email list, capped at 20. Thin wrapper over the shared `parseEmailRecipients`
 * (the single implementation shared with the low-stock alert).
 */
export function parseRecipients(v: string | null | undefined): string[] {
  return parseEmailRecipients(v);
}

/**
 * Resolve a PerfConfig from an already-fetched settings map (no DB call).
 * Numeric values are clamped to safe ranges so a typo can't set a pathological
 * sampling cadence or an impossible threshold. Fail-OPEN on sampling (defaults
 * true) and fail-CLOSED on alert email (defaults false — never email without an
 * explicit opt-in).
 */
export function resolvePerformanceConfig(
  s: Record<string, string | null>,
): PerfConfig {
  return {
    samplingEnabled: asBool(s["perf.sampling_enabled"], PERF_DEFAULTS.samplingEnabled),
    sampleIntervalSec: clampInt(
      num(s["perf.sample_interval_sec"], PERF_DEFAULTS.sampleIntervalSec),
      5,
      300,
    ),
    historySize: clampInt(num(s["perf.history_size"], PERF_DEFAULTS.historySize), 60, 1440),
    heartbeatIntervalSec: clampInt(
      num(s["perf.heartbeat_interval_sec"], PERF_DEFAULTS.heartbeatIntervalSec),
      30,
      3600,
    ),
    ramWarnPct: clampInt(num(s["perf.ram_warn_pct"], PERF_DEFAULTS.ramWarnPct), 50, 99),
    cpuWarnPct: clampInt(num(s["perf.cpu_warn_pct"], PERF_DEFAULTS.cpuWarnPct), 50, 100),
    eventLoopLagWarnMs: clampInt(
      num(s["perf.event_loop_lag_warn_ms"], PERF_DEFAULTS.eventLoopLagWarnMs),
      20,
      2000,
    ),
    dbLatencyWarnMs: clampInt(
      num(s["perf.db_latency_warn_ms"], PERF_DEFAULTS.dbLatencyWarnMs),
      50,
      5000,
    ),
    alertEmailEnabled: asBool(s["perf.alert_email_enabled"], PERF_DEFAULTS.alertEmailEnabled),
    alertCooldownMin: clampInt(
      num(s["perf.alert_cooldown_min"], PERF_DEFAULTS.alertCooldownMin),
      5,
      1440,
    ),
    alertRecipients: parseRecipients(s["perf.alert_recipients"]),
    alertBreachesRequired: clampInt(
      num(s["perf.alert_breaches_required"], PERF_DEFAULTS.alertBreachesRequired),
      1,
      10,
    ),
  };
}

/** Just the threshold sub-shape (what `evaluateBreaches` needs). */
export function thresholdsOf(cfg: PerfConfig): PerfThresholds {
  return {
    ramWarnPct: cfg.ramWarnPct,
    cpuWarnPct: cfg.cpuWarnPct,
    eventLoopLagWarnMs: cfg.eventLoopLagWarnMs,
    dbLatencyWarnMs: cfg.dbLatencyWarnMs,
  };
}

/** Which metric a breach is about. */
export type BreachMetric = "ram" | "cpu" | "event_loop" | "db_latency" | "db_down";

export type Breach = {
  metric: BreachMetric;
  /** The observed value (null for db_down, which is a connectivity failure). */
  value: number | null;
  /** The configured threshold the value met/exceeded (null for db_down). */
  threshold: number | null;
};

/** Minimal sample shape the breach evaluator reads (null = "not measured"). */
export type PerfSampleLike = {
  ramPct: number | null;
  cpuPct: number | null;
  eventLoopLagMs: number | null;
  dbLatencyMs: number | null;
  /** false ⇒ the SELECT 1 probe threw (DB unreachable) → a db_down breach. */
  dbOk: boolean;
};

/** Short human label per breach metric (FR) — pure so the UI + email reuse it. */
export const BREACH_LABELS: Record<BreachMetric, string> = {
  ram: "Mémoire (RAM)",
  cpu: "Processeur (CPU)",
  event_loop: "Latence de la boucle d'évènements",
  db_latency: "Latence base de données",
  db_down: "Base de données injoignable",
};

/**
 * The breach decision, made PURE + testable. A metric breaches when its measured
 * value is at OR above its warn threshold (>= so the boundary counts). A null
 * measurement is "not breaching" (never alert on missing data). A failed DB probe
 * (`dbOk === false`) is the standalone `db_down` breach and suppresses the
 * latency check (there is no latency when the probe threw).
 */
export function evaluateBreaches(
  sample: PerfSampleLike,
  t: PerfThresholds,
): Breach[] {
  const breaches: Breach[] = [];
  if (sample.ramPct != null && sample.ramPct >= t.ramWarnPct) {
    breaches.push({ metric: "ram", value: sample.ramPct, threshold: t.ramWarnPct });
  }
  if (sample.cpuPct != null && sample.cpuPct >= t.cpuWarnPct) {
    breaches.push({ metric: "cpu", value: sample.cpuPct, threshold: t.cpuWarnPct });
  }
  if (sample.eventLoopLagMs != null && sample.eventLoopLagMs >= t.eventLoopLagWarnMs) {
    breaches.push({
      metric: "event_loop",
      value: sample.eventLoopLagMs,
      threshold: t.eventLoopLagWarnMs,
    });
  }
  if (sample.dbOk === false) {
    breaches.push({ metric: "db_down", value: null, threshold: null });
  } else if (sample.dbLatencyMs != null && sample.dbLatencyMs >= t.dbLatencyWarnMs) {
    breaches.push({
      metric: "db_latency",
      value: sample.dbLatencyMs,
      threshold: t.dbLatencyWarnMs,
    });
  }
  return breaches;
}

/** All breach metrics, in a stable order, for the alert state machine. */
export const ALL_BREACH_METRICS: readonly BreachMetric[] = [
  "ram",
  "cpu",
  "event_loop",
  "db_latency",
  "db_down",
];

/** The alert state machine's persisted state (held on the sampler store). */
export type AlertState = {
  /** Consecutive breaching ticks per metric (debounce). */
  streak: Record<string, number>;
  /** Epoch ms of the last fired alert per metric (cooldown). */
  lastAlertAt: Record<string, number>;
  /** Metrics currently in an alerted episode (drives recovery notices). */
  active: BreachMetric[];
};

export type AlertDecision = {
  next: AlertState;
  /** Breaches that crossed debounce + cooldown this tick → fire an alert. */
  raise: Breach[];
  /** Metrics that left an active episode this tick → fire a recovery notice. */
  recover: BreachMetric[];
};

/**
 * PURE alert-transition reducer — the debounce (alertBreachesRequired) + cooldown
 * (alertCooldownMin) + recovery state machine, extracted from the sampler so it
 * can be unit-tested deterministically (the sampler just applies `next` to its
 * store and dispatches `raise`/`recover`). `nowMs` is injected for testability.
 *
 * Per metric, three episode dimensions are tracked independently:
 *   - streak: consecutive breaching ticks (the debounce).
 *   - active: whether the metric is CURRENTLY a confirmed breach. This drives the
 *     live dashboard badge, so it must mirror reality — a metric becomes active
 *     the instant its streak meets `alertBreachesRequired`, REGARDLESS of the
 *     alert cooldown (the cooldown throttles re-NOTIFICATION, never the badge).
 *   - lastAlertAt: when the metric last fired a notification (the cooldown clock).
 *
 * A breach: bumps the streak; once debounced, marks the metric active; then, only
 * if the cooldown has elapsed, fires a `raise` and re-stamps lastAlertAt. A
 * non-breach: resets the streak and, if the metric was active, clears its cooldown
 * clock and fires a single `recover`. Clearing lastAlertAt on recovery is what
 * makes a DISTINCT later episode alert immediately rather than being swallowed by
 * the recovered episode's stale cooldown — the cooldown only ever throttles a
 * single CONTINUOUS episode.
 */
export function decideAlertTransitions(
  breaches: Breach[],
  prev: AlertState,
  cfg: { alertBreachesRequired: number; alertCooldownMin: number },
  nowMs: number,
): AlertDecision {
  const byMetric = new Map<BreachMetric, Breach>(breaches.map((b) => [b.metric, b]));
  const next: AlertState = {
    streak: { ...prev.streak },
    lastAlertAt: { ...prev.lastAlertAt },
    active: [...prev.active],
  };
  const raise: Breach[] = [];
  const recover: BreachMetric[] = [];
  const cooldownMs = cfg.alertCooldownMin * 60_000;

  for (const metric of ALL_BREACH_METRICS) {
    const breach = byMetric.get(metric);
    if (breach) {
      next.streak[metric] = (prev.streak[metric] ?? 0) + 1;
      // Still debouncing — not yet a confirmed breach (no badge, no notify).
      if (next.streak[metric] < cfg.alertBreachesRequired) continue;
      // Debounce met ⇒ the metric IS breaching: reflect it in `active` NOW, even
      // if the notification is about to be cooldown-suppressed (the badge must
      // never lie about a live breach).
      if (!next.active.includes(metric)) next.active.push(metric);
      // Cooldown gate: throttle repeat NOTIFICATIONS within one continuous
      // episode. A recovery clears lastAlertAt, so a fresh episode is never
      // throttled by a prior, already-recovered one.
      const last = prev.lastAlertAt[metric] ?? 0;
      if (nowMs - last < cooldownMs) continue;
      next.lastAlertAt[metric] = nowMs;
      raise.push(breach);
    } else {
      next.streak[metric] = 0;
      if (prev.active.includes(metric)) {
        next.active = next.active.filter((m) => m !== metric);
        // End of episode — drop the cooldown clock so the NEXT distinct breach
        // alerts immediately instead of inheriting this episode's cooldown.
        delete next.lastAlertAt[metric];
        recover.push(metric);
      }
    }
  }
  return { next, raise, recover };
}
