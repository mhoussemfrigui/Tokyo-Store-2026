/**
 * PURE audit/debug config parsing — no "server-only", no DB import, so it can
 * be unit-tested directly (mirrors src/modules/search/parse-config.ts). The
 * async loader is just `getSettingsMap()` + `resolveAuditConfig(map)`.
 *
 * All keys live under the `audit.` / `debug.` prefixes and are RUNTIME-DEFAULTED
 * (no seed migration): an empty settings map yields today's behaviour
 * (everything captured, info-level console, 12-month retention, debug off).
 */

import { asBool, asEnum } from "@/lib/cms/setting-coerce";
import {
  LOG_LEVELS,
  passesSample,
  shouldLog,
  type LogLevel,
  type Severity,
} from "@/events/severity";

export type AuditConfig = {
  /** Master capture switch — when false ALL telemetry/audit subscribers early-out. */
  enabled: boolean;
  /** Console verbosity floor for the structured logger (off|error|warn|info|debug). */
  logLevel: LogLevel;
  /** Whether the long-tail wildcard subscriber persists debug-severity rows. */
  persistLowSignal: boolean;
  /** Audit-log retention window in months (drives cron + manual purge). */
  retentionMonths: number;
  /** Master debug-capture switch — forces the effective console floor to debug. */
  debugEnabled: boolean;
  /** When debug is on, also dump the (redacted) payload into the console line. */
  debugCapturePayloads: boolean;
  /** Percentage (0–100) of debug-severity lines actually logged when debug is on. */
  debugSampleRate: number;
};

export const AUDIT_DEFAULTS: AuditConfig = {
  enabled: true,
  logLevel: "info",
  persistLowSignal: true,
  retentionMonths: 12,
  debugEnabled: false,
  debugCapturePayloads: false,
  debugSampleRate: 100,
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
 * Resolve an AuditConfig from an already-fetched settings map (no DB call).
 * Numeric values are clamped to safe ranges so a typo can't disable auditing
 * by accident or set a pathological retention window. Fail-OPEN on capture
 * (enabled defaults true) and fail-CLOSED on debug (defaults false).
 */
export function resolveAuditConfig(s: Record<string, string | null>): AuditConfig {
  return {
    enabled: asBool(s["audit.enabled"], AUDIT_DEFAULTS.enabled),
    logLevel: asEnum(s["audit.log_level"], LOG_LEVELS, AUDIT_DEFAULTS.logLevel),
    persistLowSignal: asBool(s["audit.persist_low_signal"], AUDIT_DEFAULTS.persistLowSignal),
    retentionMonths: clampInt(
      num(s["audit.retention_months"], AUDIT_DEFAULTS.retentionMonths),
      1,
      60,
    ),
    debugEnabled: asBool(s["debug.enabled"], AUDIT_DEFAULTS.debugEnabled),
    debugCapturePayloads: asBool(
      s["debug.capture_payloads"],
      AUDIT_DEFAULTS.debugCapturePayloads,
    ),
    debugSampleRate: clampInt(
      num(s["debug.sample_rate"], AUDIT_DEFAULTS.debugSampleRate),
      0,
      100,
    ),
  };
}

/**
 * The console floor actually applied: a master debug toggle forces "debug"
 * (everything prints) regardless of the configured level; a disabled capture
 * switch silences the console entirely.
 */
export function effectiveLogLevel(cfg: AuditConfig): LogLevel {
  if (!cfg.enabled) return "off";
  if (cfg.debugEnabled) return "debug";
  return cfg.logLevel;
}

/**
 * The structured-logger's emit decision, made pure + testable. Given the
 * config, an event's severity, and an injected [0,1) random:
 *   - log: clears the effective console floor (off silences all; debug floor
 *     prints everything), and debug-severity lines pass the sample gate.
 *   - includePayload: payload is shown by default; during debug it is opt-in
 *     (debug.capture_payloads) so the firehose stays lean unless asked.
 */
export function decideLogLine(
  cfg: AuditConfig,
  severity: Severity,
  rnd: number,
): { log: boolean; includePayload: boolean } {
  const floor = effectiveLogLevel(cfg);
  if (!shouldLog(floor, severity)) return { log: false, includePayload: false };
  if (severity === "debug" && !passesSample(cfg.debugSampleRate, rnd)) {
    return { log: false, includePayload: false };
  }
  return { log: true, includePayload: cfg.debugEnabled ? cfg.debugCapturePayloads : true };
}
