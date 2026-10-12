import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { nextDispatchAtMs } from "@/lib/jobs/dispatch-schedule";
import { isCentralizedJob, isJobEnabled } from "@/lib/jobs/run-job";
import { toJobRunView, type JobOverview } from "@/lib/jobs/views";
import { jobRunLogService } from "@/modules/jobs";
import { AdminPageHeader } from "@/components/admin/page-header";
import { JobsPanel } from "./jobs-panel";

export const metadata: Metadata = { title: "Tâches planifiées" };

// Reads live job state (schedule row + run log) — never cache.
export const dynamic = "force-dynamic";

/** Assemble the per-job snapshot for every registered scheduled/cron job. */
async function buildOverviews(): Promise<JobOverview[]> {
  const keys = SCHEDULED_JOBS.map((j) => j.key);
  const [lastRuns, lastExecuted, lastFailures, jobEnabled] = await Promise.all([
    jobRunLogService.lastRunByJob(keys),
    // « Prochaine » anchors on the last EXECUTED run (mirrors the dispatcher), while the
    // « Dernière » display below uses lastRunByJob so a failure is still visible.
    jobRunLogService.lastExecutedRunByJob(keys),
    jobRunLogService.lastFailureByJob(keys),
    // Per-job kill-switch state for the externally-scheduled crons (site_settings
    // `jobs.<key>.enabled`; missing ⇒ enabled). One pass, no N+1 on render.
    Promise.all(
      SCHEDULED_JOBS.filter((j) => isCentralizedJob(j.key)).map(
        async (j) => [j.key, await isJobEnabled(j.key)] as const,
      ),
    ),
  ]);
  const enabledByKey = new Map(jobEnabled);

  return SCHEDULED_JOBS.map((def): JobOverview => {
    const last = lastRuns.get(def.key);
    const lastFailed = lastFailures.get(def.key);
    const base = {
      key: def.key,
      lastRun: last ? toJobRunView(last) : null,
      lastFailure: lastFailed ? toJobRunView(lastFailed) : null,
    };

    // External jobs are driven by the single `/api/cron/dispatch` heartbeat: it reads
    // each job's machine cadence (def.dispatch) and runs the due ones. The whole system
    // is CRON_SECRET-gated (503 without it) so report "configured" only when the secret
    // is set. Each carries an in-app kill-switch (site_settings `jobs.<key>.enabled`)
    // the heartbeat respects, surfaced as the enable/disable toggle. « Prochaine » is
    // computed from the cadence + last run so the operator sees the next fire here.
    if (def.type === "external") {
      const enabled = enabledByKey.get(def.key) ?? true;
      const configured = Boolean(process.env.CRON_SECRET);
      const exec = lastExecuted.get(def.key);
      const lastMs = exec ? new Date(exec.started_at).getTime() : null;
      const nextMs = enabled && configured ? nextDispatchAtMs(def.dispatch, lastMs, Date.now()) : null;
      return {
        ...base,
        enabled,
        scheduleText: enabled ? def.defaultSchedule : "En pause (désactivée)",
        nextRunAt: nextMs != null ? new Date(nextMs).toISOString() : null,
        lastError: null,
        configured,
      };
    }

    return {
      ...base,
      enabled: null,
      scheduleText: def.defaultSchedule,
      nextRunAt: null,
      lastError: null,
      configured: true,
    };
  });
}

export default async function ScheduledJobsPage() {
  await requirePermission("system_jobs", "view");
  const [overviews, recentRows] = await Promise.all([
    buildOverviews(),
    // Restrict the cross-job activity table to registered jobs so retired/
    // renamed job_keys can't crowd out the real ones.
    jobRunLogService.listRecent(50, SCHEDULED_JOBS.map((j) => j.key)),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/system"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour aux outils système
        </Link>
        <div className="mt-2">
          <AdminPageHeader
            title="Tâches planifiées"
            description="Toutes les tâches récurrentes (planificateurs internes et crons externes) : état, cadence, dernière exécution et historique. Activez/désactivez, lancez à la demande, et consultez les journaux d'exécution."
          />
        </div>
      </div>

      <JobsPanel overviews={overviews} recentRuns={recentRows.map(toJobRunView)} />
    </div>
  );
}
