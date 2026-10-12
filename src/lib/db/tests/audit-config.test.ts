/**
 * Pure audit/debug config resolver (src/lib/audit/parse-config.ts). No DB.
 * Locks the runtime defaults, clamping, and the effective-log-level rule
 * (debug forces "debug"; capture off ⇒ "off").
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/audit-config.test.ts
 */
import {
  resolveAuditConfig,
  effectiveLogLevel,
  decideLogLine,
  AUDIT_DEFAULTS,
} from "@/lib/audit/parse-config";

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
  console.log("defaults (empty map yields today's behaviour):");
  const def = resolveAuditConfig({});
  check("enabled defaults true (fail-open)", def.enabled === true);
  check("logLevel defaults info", def.logLevel === "info");
  check("persistLowSignal defaults true", def.persistLowSignal === true);
  check("retentionMonths defaults 12", def.retentionMonths === 12);
  check("debugEnabled defaults false (fail-closed)", def.debugEnabled === false);
  check("debugCapturePayloads defaults false", def.debugCapturePayloads === false);
  check("debugSampleRate defaults 100", def.debugSampleRate === 100);
  check("matches AUDIT_DEFAULTS", JSON.stringify(def) === JSON.stringify(AUDIT_DEFAULTS));

  console.log("parsing + clamping:");
  check(
    "log level parsed (case-insensitive)",
    resolveAuditConfig({ "audit.log_level": "WARN" }).logLevel === "warn",
  );
  check(
    "unknown log level → default info",
    resolveAuditConfig({ "audit.log_level": "loud" }).logLevel === "info",
  );
  check("off is a valid level", resolveAuditConfig({ "audit.log_level": "off" }).logLevel === "off");
  check(
    "retention clamped to [1,60] — 0 → 1",
    resolveAuditConfig({ "audit.retention_months": "0" }).retentionMonths === 1,
  );
  check(
    "retention clamped to [1,60] — 999 → 60",
    resolveAuditConfig({ "audit.retention_months": "999" }).retentionMonths === 60,
  );
  check(
    "blank retention → default 12 (Number(\"\") guard)",
    resolveAuditConfig({ "audit.retention_months": "" }).retentionMonths === 12,
  );
  check(
    "sample rate clamped [0,100] — 250 → 100",
    resolveAuditConfig({ "debug.sample_rate": "250" }).debugSampleRate === 100,
  );
  check(
    "sample rate -5 → 0",
    resolveAuditConfig({ "debug.sample_rate": "-5" }).debugSampleRate === 0,
  );
  check(
    "enabled=off parsed false",
    resolveAuditConfig({ "audit.enabled": "off" }).enabled === false,
  );
  check(
    "debug.enabled=true parsed",
    resolveAuditConfig({ "debug.enabled": "true" }).debugEnabled === true,
  );

  console.log("effectiveLogLevel:");
  check(
    "capture off ⇒ off (silences console)",
    effectiveLogLevel(resolveAuditConfig({ "audit.enabled": "false" })) === "off",
  );
  check(
    "debug on forces debug regardless of level",
    effectiveLogLevel(resolveAuditConfig({ "audit.log_level": "error", "debug.enabled": "true" })) ===
      "debug",
  );
  check(
    "normal: returns configured level",
    effectiveLogLevel(resolveAuditConfig({ "audit.log_level": "warn" })) === "warn",
  );
  check(
    "capture off beats debug on (off wins)",
    effectiveLogLevel(resolveAuditConfig({ "audit.enabled": "false", "debug.enabled": "true" })) ===
      "off",
  );

  console.log("decideLogLine — console emit decision:");
  const defCfg = resolveAuditConfig({});
  check("info event logs at default (info floor)", decideLogLine(defCfg, "info", 0.5).log === true);
  check("debug event does NOT log at info floor", decideLogLine(defCfg, "debug", 0).log === false);
  check("payload included by default (debug off)", decideLogLine(defCfg, "info", 0.5).includePayload === true);

  const off = resolveAuditConfig({ "audit.enabled": "false" });
  check("capture off silences even error", decideLogLine(off, "error", 0).log === false);

  const debugOn = resolveAuditConfig({ "debug.enabled": "true" });
  check("debug.enabled logs debug events", decideLogLine(debugOn, "debug", 0).log === true);
  check(
    "debug payload opt-in: off by default during debug",
    decideLogLine(debugOn, "info", 0).includePayload === false,
  );
  check(
    "debug payload opt-in: on when capture_payloads set",
    decideLogLine(
      resolveAuditConfig({ "debug.enabled": "true", "debug.capture_payloads": "true" }),
      "info",
      0,
    ).includePayload === true,
  );

  const debugSampled = resolveAuditConfig({ "debug.enabled": "true", "debug.sample_rate": "50" });
  check("debug sample: rnd 0.4 passes at 50%", decideLogLine(debugSampled, "debug", 0.4).log === true);
  check("debug sample: rnd 0.6 dropped at 50%", decideLogLine(debugSampled, "debug", 0.6).log === false);
  check(
    "warn never sampled out even with low sample_rate",
    decideLogLine(resolveAuditConfig({ "debug.enabled": "true", "debug.sample_rate": "0" }), "warn", 0.99).log ===
      true,
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
