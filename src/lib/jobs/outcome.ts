import type { JobRunStatus } from "@/modules/jobs/schema";

/**
 * PURE decision helpers for the scheduled-job run layer (no DB / server-only) so
 * the centralization's core branching is unit-testable. Used by both
 * `jobRunLogService.runAndLog` and `runScheduledJob`.
 */

/**
 * Map a job-work result to the status recorded in `job_run_log`. A work fn may
 * opt into "skipped" (a no-op run) or "failed" (a REPORTED failure returned as
 * an object rather than thrown — the scheduled-job work fns are defensive);
 * anything else is "ok". A THROWN error is recorded "failed" by runAndLog's
 * catch, not here.
 */
export function resolveJobRunStatus(
  result: { status?: JobRunStatus } | null | undefined,
): JobRunStatus {
  if (result?.status === "skipped") return "skipped";
  if (result?.status === "failed") return "failed";
  return "ok";
}

/**
 * Interpret a per-job kill-switch setting value (`jobs.<key>.enabled`). A MISSING
 * row or any value other than the literal "false" means ENABLED — so a fresh
 * deploy (no setting row yet) keeps every job running, and only an explicit pause
 * disables it.
 */
export function isEnabledSettingValue(value: string | null | undefined): boolean {
  return value !== "false";
}

/** HTTP status for a finished job run — 500 only on failure, else 200 (incl. skipped). */
export function jobRunHttpStatus(status: JobRunStatus): number {
  return status === "failed" ? 500 : 200;
}
