/**
 * Pure decision helpers for the scheduled-job run layer — the branching the
 * "Tâches planifiées" centralization depends on. No DB / network, so this runs
 * without Docker.
 *
 *  • resolveJobRunStatus — a work fn opts into skipped/failed, else ok; this is
 *    what makes a NON-throwing {status:"failed"} get recorded as a failed run.
 *  • isEnabledSettingValue — the kill-switch read: missing / non-"false" ⇒
 *    ENABLED (a fresh deploy keeps every job running).
 *  • jobRunHttpStatus — 500 only on failure.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/job-outcome.test.ts
 */
import {
  isEnabledSettingValue,
  jobRunHttpStatus,
  resolveJobRunStatus,
} from "@/lib/jobs/outcome";

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
  console.log("resolveJobRunStatus:");
  check("undefined → ok", resolveJobRunStatus(undefined) === "ok");
  check("null → ok", resolveJobRunStatus(null) === "ok");
  check("no status → ok", resolveJobRunStatus({}) === "ok");
  check("explicit ok", resolveJobRunStatus({ status: "ok" }) === "ok");
  check("skipped honored", resolveJobRunStatus({ status: "skipped" }) === "skipped");
  check(
    "failed honored (non-throwing reported failure)",
    resolveJobRunStatus({ status: "failed" }) === "failed",
  );

  console.log("isEnabledSettingValue:");
  check("missing (undefined) ⇒ enabled", isEnabledSettingValue(undefined) === true);
  check("null ⇒ enabled", isEnabledSettingValue(null) === true);
  check('"true" ⇒ enabled', isEnabledSettingValue("true") === true);
  check('"false" ⇒ disabled', isEnabledSettingValue("false") === false);
  check('empty string ⇒ enabled (only literal "false" disables)', isEnabledSettingValue("") === true);
  check('garbage ⇒ enabled', isEnabledSettingValue("nope") === true);

  console.log("jobRunHttpStatus:");
  check("ok → 200", jobRunHttpStatus("ok") === 200);
  check("skipped → 200", jobRunHttpStatus("skipped") === 200);
  check("failed → 500", jobRunHttpStatus("failed") === 500);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
