import "server-only";

import os from "node:os";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";
import { sql } from "drizzle-orm";

import { db, getPoolStats } from "@/lib/db/client";
import { getPerfRuntimeConfig } from "./perf-runtime-config";
import {
  evaluateBreaches,
  thresholdsOf,
  decideAlertTransitions,
  type BreachMetric,
  type PerfConfig,
} from "./perf-config";
import { raisePerfAlert, recoverPerfAlert } from "./perf-alert";
import { instanceHeartbeatService } from "@/modules/instance";

/**
 * In-process runtime-metrics sampler — RAM / CPU / event-loop lag / DB latency.
 *
 * Zero new dependencies: node:os + node:process + node:perf_hooks. State is
 * pinned on `globalThis` (survives Next.js HMR in dev, like metrics-store.ts) and
 * is PROCESS-LOCAL — it reflects THIS Node instance only, never the whole parc.
 * The sampler is a single self-rescheduling timer started from instrumentation.ts
 * (no external cron); it reads its cadence + thresholds from the admin-tunable
 * perf config each tick, evaluates breaches (debounced + cooldown'd) into alerts,
 * and periodically writes a DB heartbeat that drives uptime/downtime tracking.
 *
 * Every read is wrapped so the sampler can never crash the process, and the live
 * snapshot getter degrades to nulls rather than throwing into an admin page.
 */

/** One compact ring-buffer row (kept in memory for the Historique view). */
export type RuntimeSample = {
  /** Epoch ms when the sample was taken. */
  at: number;
  /** RSS as a % of the container/host memory limit (null if undeterminable). */
  ramPct: number | null;
  /** Resident set size in bytes. */
  rssBytes: number;
  /** V8 heap used in bytes. */
  heapUsedBytes: number;
  /** Process CPU % normalised by core count (null only if process.cpuUsage is
   *  unavailable or the elapsed window is non-positive; a normal first tick
   *  measures the boot→first-tick window, since the deltas are seeded at boot). */
  cpuPct: number | null;
  /** Event-loop delay p99 over the last window, in ms (null if unavailable). */
  eventLoopLagMs: number | null;
  /** DB round-trip latency for a `SELECT 1`, in ms (null when the probe threw). */
  dbLatencyMs: number | null;
  /** false ⇒ the DB probe threw (connection unreachable). */
  dbOk: boolean;
  /** Clients waiting on the pool at sample time (back-pressure signal). */
  poolWaiting: number;
};

/** Live snapshot for the admin overview + the poll endpoint. */
export type RuntimeSnapshot = {
  instanceId: string;
  bootAt: number;
  /** Wall-clock ms since this store was created (≈ instance uptime). */
  uptimeMs: number;
  nodeVersion: string;
  cpuCount: number;
  loadAvg1: number | null;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
    /** The denominator used for ramPct (cgroup limit or host total). */
    limitBytes: number;
    /** OS-reported free/total (host-level, may exceed the container limit). */
    sysFreeBytes: number;
    sysTotalBytes: number;
  };
  ramPct: number | null;
  cpuPct: number | null;
  eventLoopLagMs: number | null;
  db: { latencyMs: number | null; ok: boolean };
  pool: ReturnType<typeof getPoolStats> | null;
  /** Whether the background sampler timer is alive (process-level). */
  samplerRunning: boolean;
  /** Whether metric SAMPLING is enabled (perf.sampling_enabled). When false the
   *  cpuPct/eventLoopLagMs below are stale — the UI shows them paused. Heartbeats
   *  + RAM/DB-latency probe still run regardless. */
  samplingEnabled: boolean;
  /** Epoch ms of the most recent ring sample (null if none yet). */
  lastSampleAt: number | null;
  /** Active (currently-breaching, alerted) metrics for the status badge. */
  activeBreaches: BreachMetric[];
};

type Store = {
  instanceId: string;
  bootAt: number;
  history: RuntimeSample[];
  last: RuntimeSample | null;
  cpuPrev: NodeJS.CpuUsage;
  hrPrev: bigint;
  eld: IntervalHistogram | null;
  timer: NodeJS.Timeout | null;
  /** Consecutive breaching ticks per metric (for the debounce). */
  streak: Record<string, number>;
  /** Epoch ms of the last fired alert per metric (for the cooldown). */
  lastAlertAt: Record<string, number>;
  /** Metrics currently in an alerted state (for recovery notifications). */
  active: Set<BreachMetric>;
  lastHeartbeatAt: number;
  /** Last-resolved perf.sampling_enabled (for the snapshot's paused state). */
  samplingEnabled: boolean;
  dbProbeInflight: Promise<{ dbLatencyMs: number | null; dbOk: boolean }> | null;
  /** Set during drain so a resuming in-flight tick won't re-arm the timer. */
  stopping: boolean;
  /** The currently-running tick, so the drain can await it (clean shutdown). */
  tickInflight: Promise<void> | null;
};

declare global {
  var __gz_runtime_metrics: Store | undefined;
}

/** A short, dependency-free random id so an operator can tell replicas apart. */
function randomInstanceId(): string {
  return (
    Date.now().toString(36) +
    "-" +
    Math.floor(Math.random() * 0xffffff).toString(36).padStart(4, "0")
  );
}

function initStore(): Store {
  let eld: IntervalHistogram | null = null;
  try {
    eld = monitorEventLoopDelay({ resolution: 20 });
    eld.enable();
  } catch {
    eld = null;
  }
  return {
    instanceId: randomInstanceId(),
    bootAt: Date.now(),
    history: [],
    last: null,
    cpuPrev: process.cpuUsage(),
    hrPrev: process.hrtime.bigint(),
    eld,
    timer: null,
    streak: {},
    lastAlertAt: {},
    active: new Set(),
    lastHeartbeatAt: 0,
    samplingEnabled: true,
    dbProbeInflight: null,
    stopping: false,
    tickInflight: null,
  };
}

function store(): Store {
  return (globalThis.__gz_runtime_metrics ??= initStore());
}

/** cgroup-aware memory limit (Node 20+), falling back to the host total. */
function memLimitBytes(): number {
  const total = os.totalmem();
  const hostTotal = Number.isFinite(total) && total > 0 ? total : 0;
  try {
    const fn = (process as unknown as { constrainedMemory?: () => number }).constrainedMemory;
    if (typeof fn === "function") {
      const c = fn.call(process);
      // constrainedMemory() returns 0 OR a near-2^64 sentinel when there is NO
      // cgroup limit (seen on the unconstrained host: ~16777216 TB). Only trust
      // it as the RAM% denominator when it's a REAL limit below the host total —
      // otherwise RAM% reads a meaningless ~0% against an 18-EB "limit".
      if (Number.isFinite(c) && c > 0 && hostTotal > 0 && c < hostTotal) return c;
    }
  } catch {
    /* fall through to host total */
  }
  return hostTotal;
}

const round = (n: number, dp = 1): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * Timed `SELECT 1` round-trip, fail-soft + single-flight (concurrent in-process
 * callers share one in-flight probe). Module-private — the cross-file probe used
 * by the Database + Ressources pages is `pingDbSamples` below.
 */
async function pingDb(): Promise<{ dbLatencyMs: number | null; dbOk: boolean }> {
  const s = store();
  if (s.dbProbeInflight) return s.dbProbeInflight;
  s.dbProbeInflight = (async () => {
    const t0 = performance.now();
    try {
      // A POOLED query (not a transaction). The pool already enforces a 3s
      // connect timeout + 10s statement_timeout, so a struggling DB can't hang
      // the admin page on this probe.
      await db.execute(sql`SELECT 1`);
      return { dbLatencyMs: round(performance.now() - t0, 2), dbOk: true };
    } catch {
      return { dbLatencyMs: null, dbOk: false };
    } finally {
      s.dbProbeInflight = null;
    }
  })();
  return s.dbProbeInflight;
}

/**
 * Run `n` sequential timed `SELECT 1` probes → min/median/max round-trip in ms.
 * Shared with the Database diagnostics tab so there is ONE probe implementation,
 * not two. Fail-soft: `ok=false` if any probe threw; returns nulls if all did.
 */
export async function pingDbSamples(n = 5): Promise<{
  minMs: number | null;
  medianMs: number | null;
  maxMs: number | null;
  ok: boolean;
  samples: number;
}> {
  const times: number[] = [];
  let ok = true;
  const rounds = Math.max(1, Math.min(n, 20));
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    try {
      await db.execute(sql`SELECT 1`);
      times.push(performance.now() - t0);
    } catch {
      ok = false;
    }
  }
  if (times.length === 0) {
    return { minMs: null, medianMs: null, maxMs: null, ok: false, samples: 0 };
  }
  const sorted = times.slice().sort((a, b) => a - b);
  return {
    minMs: round(sorted[0], 2),
    medianMs: round(sorted[Math.floor(sorted.length / 2)], 2),
    maxMs: round(sorted[sorted.length - 1], 2),
    ok,
    samples: times.length,
  };
}

/** Read RAM + CPU% + event-loop lag (no DB). Mutates cpu/hr/eld deltas. */
function readSystemMetrics(s: Store): {
  ramPct: number | null;
  rssBytes: number;
  heapUsedBytes: number;
  cpuPct: number | null;
  eventLoopLagMs: number | null;
} {
  let rssBytes = 0;
  let heapUsedBytes = 0;
  let ramPct: number | null = null;
  try {
    const mem = process.memoryUsage();
    rssBytes = mem.rss;
    heapUsedBytes = mem.heapUsed;
    const limit = memLimitBytes();
    ramPct = limit > 0 ? round((mem.rss / limit) * 100) : null;
  } catch {
    /* leave zeros / null */
  }

  let cpuPct: number | null = null;
  try {
    const cpuNow = process.cpuUsage();
    const hrNow = process.hrtime.bigint();
    const elapsedMicros = Number(hrNow - s.hrPrev) / 1000; // ns → µs
    const usedMicros =
      cpuNow.user - s.cpuPrev.user + (cpuNow.system - s.cpuPrev.system);
    const cores = os.cpus()?.length || 1;
    if (elapsedMicros > 0) {
      cpuPct = round(Math.max(0, Math.min(100, (usedMicros / (elapsedMicros * cores)) * 100)));
    }
    s.cpuPrev = cpuNow;
    s.hrPrev = hrNow;
  } catch {
    /* leave null */
  }

  let eventLoopLagMs: number | null = null;
  try {
    if (s.eld) {
      // p99 in ms (histogram reports ns); reset so each window is independent.
      eventLoopLagMs = round(s.eld.percentile(99) / 1e6, 1);
      s.eld.reset();
    }
  } catch {
    eventLoopLagMs = null;
  }

  return { ramPct, rssBytes, heapUsedBytes, cpuPct, eventLoopLagMs };
}

/** Take ONE full sample (system + DB) and push it into the ring. Never throws. */
async function collectSample(historySize: number): Promise<RuntimeSample> {
  const s = store();
  const sysm = readSystemMetrics(s);
  const probe = await pingDb();
  let poolWaiting = 0;
  try {
    poolWaiting = getPoolStats().waiting;
  } catch {
    /* leave 0 */
  }
  const sample: RuntimeSample = {
    at: Date.now(),
    ramPct: sysm.ramPct,
    rssBytes: sysm.rssBytes,
    heapUsedBytes: sysm.heapUsedBytes,
    cpuPct: sysm.cpuPct,
    eventLoopLagMs: sysm.eventLoopLagMs,
    dbLatencyMs: probe.dbLatencyMs,
    dbOk: probe.dbOk,
    poolWaiting,
  };
  s.last = sample;
  s.history.push(sample);
  // Trim to the configured window from the FRONT (oldest first).
  const cap = Math.max(60, Math.min(historySize, 1440));
  if (s.history.length > cap) s.history.splice(0, s.history.length - cap);
  return sample;
}

/**
 * Debounce + cooldown breach handling. The DECISION (streak/cooldown/recovery)
 * is the pure, tested `decideAlertTransitions` (perf-config.ts); here we just
 * read/write the store state and dispatch the resulting raises/recoveries to
 * perf-alert.ts (bus event + optional email), best-effort.
 */
async function evaluateAlerts(sample: RuntimeSample, cfg: PerfConfig): Promise<void> {
  const s = store();
  const breaches = evaluateBreaches(sample, thresholdsOf(cfg));
  const { next, raise, recover } = decideAlertTransitions(
    breaches,
    { streak: s.streak, lastAlertAt: s.lastAlertAt, active: Array.from(s.active) },
    cfg,
    Date.now(),
  );
  s.streak = next.streak;
  s.lastAlertAt = next.lastAlertAt;
  s.active = new Set(next.active);

  for (const breach of raise) {
    await raisePerfAlert(breach, sample, cfg, s.instanceId).catch((err) =>
      console.error("[perf] raise alert failed", err),
    );
  }
  for (const metric of recover) {
    await recoverPerfAlert(metric, sample, cfg, s.instanceId).catch((err) =>
      console.error("[perf] recovery notice failed", err),
    );
  }
}

/** Upsert the DB heartbeat if the configured interval has elapsed. Best-effort. */
async function maybeHeartbeat(cfg: PerfConfig): Promise<void> {
  const s = store();
  const now = Date.now();
  if (now - s.lastHeartbeatAt < cfg.heartbeatIntervalSec * 1000) return;
  s.lastHeartbeatAt = now;
  const buildSha = process.env.NEXT_PUBLIC_BUILD_SHA?.trim() || null;
  await instanceHeartbeatService
    .beat({ instanceId: s.instanceId, startedAt: new Date(s.bootAt), buildSha })
    .catch((err) => console.error("[perf] heartbeat failed", err));
}

/** The actual sample work for one tick — returns the cadence for the next one. */
async function doTick(): Promise<number> {
  let intervalSec = 10;
  try {
    const cfg = await getPerfRuntimeConfig();
    intervalSec = cfg.sampleIntervalSec;
    const s = store();
    s.samplingEnabled = cfg.samplingEnabled;
    if (cfg.samplingEnabled) {
      const sample = await collectSample(cfg.historySize);
      await evaluateAlerts(sample, cfg);
    } else {
      // Sampling paused — KEEP the rolling measurement windows fresh so the
      // first sample after re-enable reflects only the new window, not the whole
      // disabled span (the event-loop histogram + CPU/hr deltas accumulate
      // otherwise → a garbage first reading that could trip an alert). Also CLEAR
      // the WHOLE alert episode: a monitoring gap is not an observed recovery, so
      // the next enabled tick must not emit a spurious "rétabli". We clear all
      // THREE episode dimensions — streak (debounce), active (badge) AND
      // lastAlertAt (cooldown clock) — so a resume starts genuinely clean: an
      // ongoing breach that straddled the pause re-alerts promptly instead of
      // being silently suppressed by the pre-pause cooldown.
      try {
        s.eld?.reset();
      } catch {
        /* ignore */
      }
      try {
        s.cpuPrev = process.cpuUsage();
        s.hrPrev = process.hrtime.bigint();
      } catch {
        /* ignore */
      }
      s.active.clear();
      s.streak = {};
      s.lastAlertAt = {};
    }
    // Heartbeat ALWAYS runs (liveness != metric sampling): it is the source of
    // truth for the uptime/downtime view, so pausing sampling must NOT make a
    // live, healthy instance look like an outage.
    await maybeHeartbeat(cfg);
  } catch (err) {
    console.error("[perf] sampler tick failed", err);
  }
  return intervalSec;
}

/** Run one tick, tracking it on the store so the drain can await it. */
function runTick(): void {
  const s = store();
  if (s.tickInflight) return; // never overlap
  s.tickInflight = (async () => {
    const intervalSec = await doTick();
    s.tickInflight = null;
    // Re-arm UNLESS we're draining (a tick that resumes mid-shutdown must not
    // resurrect the timer after stopRuntimeSampler cleared it).
    if (!s.stopping) schedule(intervalSec);
  })();
}

function schedule(intervalSec: number): void {
  const s = store();
  if (s.stopping) return;
  if (s.timer) clearTimeout(s.timer);
  const ms = Math.max(5, Math.min(intervalSec, 300)) * 1000;
  s.timer = setTimeout(() => runTick(), ms);
  // Don't keep the event loop alive for the timer alone (clean shutdown).
  s.timer.unref?.();
}

/** Start the sampler (idempotent). Called from instrumentation.ts on boot. */
export function startRuntimeSampler(): void {
  const s = store();
  s.stopping = false;
  if (s.timer) return; // already running
  // Kick a first sample shortly after boot, then self-reschedule from config.
  schedule(2);
}

/**
 * Stop the sampler + mark the instance stopped. Called from the drain path.
 * Mirrors drainReviewScheduler: flag `stopping` so a resuming tick won't re-arm,
 * clear the timer, then AWAIT any in-flight tick (bounded) so its SELECT 1 /
 * heartbeat finishes before the caller closes the pool.
 */
export async function stopRuntimeSampler(): Promise<void> {
  const s = store();
  s.stopping = true;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  if (s.tickInflight) {
    // Bounded so a hung query can't block shutdown past Docker's SIGTERM grace.
    await Promise.race([
      s.tickInflight,
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]).catch(() => {});
  }
  try {
    s.eld?.disable();
  } catch {
    /* ignore */
  }
  await instanceHeartbeatService.markStopped(s.instanceId).catch(() => {});
}

/**
 * Live snapshot for the admin overview / poll endpoint. Reads memory + pool
 * instantaneously and runs a fresh (single-flight) DB probe, but takes
 * CPU%/event-loop lag from the LAST timer sample (those need a delta the timer
 * owns — recomputing here would corrupt the running delta). Never throws.
 */
export async function getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  const s = store();
  let memory: RuntimeSnapshot["memory"] = {
    rssBytes: 0,
    heapUsedBytes: 0,
    heapTotalBytes: 0,
    externalBytes: 0,
    limitBytes: 0,
    sysFreeBytes: 0,
    sysTotalBytes: 0,
  };
  let ramPct: number | null = null;
  try {
    const mem = process.memoryUsage();
    const limit = memLimitBytes();
    memory = {
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      limitBytes: limit,
      sysFreeBytes: os.freemem(),
      sysTotalBytes: os.totalmem(),
    };
    ramPct = limit > 0 ? round((mem.rss / limit) * 100) : null;
  } catch {
    /* leave defaults */
  }

  const probe = await pingDb();
  let pool: RuntimeSnapshot["pool"] = null;
  try {
    pool = getPoolStats();
  } catch {
    pool = null;
  }
  let loadAvg1: number | null = null;
  try {
    loadAvg1 = os.loadavg()[0] ?? null;
  } catch {
    loadAvg1 = null;
  }

  return {
    instanceId: s.instanceId,
    bootAt: s.bootAt,
    uptimeMs: Date.now() - s.bootAt,
    nodeVersion: process.version,
    cpuCount: os.cpus()?.length || 1,
    loadAvg1,
    memory,
    ramPct,
    cpuPct: s.last?.cpuPct ?? null,
    eventLoopLagMs: s.last?.eventLoopLagMs ?? null,
    db: { latencyMs: probe.dbLatencyMs, ok: probe.dbOk },
    pool,
    samplerRunning: s.timer != null,
    samplingEnabled: s.samplingEnabled,
    lastSampleAt: s.last?.at ?? null,
    activeBreaches: Array.from(s.active),
  };
}

/** The in-memory ring buffer (oldest → newest). Process-local. */
export function getRuntimeHistory(): RuntimeSample[] {
  return [...store().history];
}
