import type { JobRunLogRow, JobRunStatus, JobRunTrigger } from "@/modules/jobs";

/**
 * Serializable view-models for the "Tâches planifiées" dashboard. Pure (no
 * server-only imports) so both the server page and the client panel can use
 * them, and so the `"use server"` actions file can re-export the types without
 * tripping the "only async exports" rule.
 */

export type JobRunView = {
  id: string;
  jobKey: string;
  status: JobRunStatus;
  trigger: JobRunTrigger;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  summary: string | null;
  error: string | null;
};

export function toJobRunView(r: JobRunLogRow): JobRunView {
  return {
    id: r.id,
    jobKey: r.job_key,
    status: r.status,
    trigger: r.trigger,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
    durationMs: r.duration_ms ?? null,
    summary: r.summary ?? null,
    error: r.error ?? null,
  };
}

/** Per-job snapshot the dashboard card renders. */
export type JobOverview = {
  key: string;
  /** Toggle state for controllable jobs; null when the job can't be toggled. */
  enabled: boolean | null;
  /** Human cadence ("Tous les 3 jours", "Quotidien (cron externe)", …). */
  scheduleText: string;
  nextRunAt: string | null;
  lastError: string | null;
  lastRun: JobRunView | null;
  /** Latest FAILED run (may be older than lastRun) — kept visible on the card
   *  after later no-op / ok runs, which would otherwise hide it. */
  lastFailure: JobRunView | null;
  /** External jobs: whether the trigger (e.g. CRON_SECRET) is configured. */
  configured: boolean;
};

/** Render a cadence in hours as a French human string. */
export function cadenceText(hours: number): string {
  if (hours % 24 === 0) {
    const d = hours / 24;
    return d === 1 ? "Tous les jours" : `Tous les ${d} jours`;
  }
  return hours === 1 ? "Toutes les heures" : `Toutes les ${hours} h`;
}
