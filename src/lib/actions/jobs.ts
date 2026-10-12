"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/lib/auth/session";
import { getScheduledJob } from "@/lib/jobs/registry";
import { toJobRunView, type JobRunView } from "@/lib/jobs/views";
import { isCentralizedJob, runScheduledJob, setJobEnabled } from "@/lib/jobs/run-job";
import { jobRunLogService } from "@/modules/jobs";
// (retention purge now runs through runScheduledJob — no direct import needed)
import { bus } from "@/events/bus";

/**
 * Server actions for the admin "Tâches planifiées" dashboard. Each acts on a
 * job by its registry key (see `@/lib/jobs/registry`), gating on the registry's
 * `runnable`/`controllable` flags so the UI and the action can't disagree.
 */

const JOBS_PATH = "/admin/system/jobs";

export type { JobRunView } from "@/lib/jobs/views";

/**
 * Recent run history — for a single job, or all jobs when `jobKey` is omitted.
 * `hideSkipped` (single job only) drops the no-op « Ignoré » heartbeat rows so
 * the real runs behind them are reachable.
 */
export async function listJobRunsAction(
  jobKey?: string,
  limit = 50,
  opts: { hideSkipped?: boolean } = {},
): Promise<JobRunView[]> {
  await requirePermission("system_jobs", "view");
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 50));
  const rows = jobKey
    ? await jobRunLogService.listForJob(jobKey, safeLimit, { hideSkipped: opts?.hideSkipped === true })
    : await jobRunLogService.listRecent(safeLimit);
  return rows.map(toJobRunView);
}

/** Enable/disable a controllable job (the externally-scheduled crons). */
export async function setJobEnabledAction(
  jobKey: string,
  enabled: boolean,
): Promise<{ ok: boolean; message: string }> {
  const session = await requirePermission("system_jobs", "manage");
  const def = getScheduledJob(jobKey);
  if (!def || !def.controllable) {
    return { ok: false, message: "Cette tâche ne peut pas être activée/désactivée ici." };
  }
  // Externally-scheduled crons use the shared site_settings kill-switch
  // (`jobs.<key>.enabled`) that runScheduledJob checks before each cron run.
  if (isCentralizedJob(jobKey)) {
    await setJobEnabled(jobKey, enabled);
    await bus.emit("job.enabled_changed", { jobKey, enabled }, { actorUserId: session.user.id });
    revalidatePath(JOBS_PATH);
    return {
      ok: true,
      message: enabled
        ? "Tâche activée — elle s'exécutera à la prochaine échéance du cron."
        : "Tâche désactivée — les exécutions automatiques sont en pause (vous pouvez toujours la lancer à la demande).",
    };
  }
  return { ok: false, message: "Tâche inconnue." };
}

/**
 * Trigger an immediate run. The retention purge runs synchronously and is logged
 * here (trigger "manual"); the UI gates it behind a destructive confirm.
 */
export async function runJobNowAction(jobKey: string): Promise<{ ok: boolean; message: string }> {
  const session = await requirePermission("system_jobs", "manage");
  const def = getScheduledJob(jobKey);
  if (!def || !def.runnable) {
    return { ok: false, message: "Cette tâche ne peut pas être exécutée manuellement." };
  }

  // Every externally-scheduled job (the ones in JOB_WORK: retention_purge,
  // mailing_queue, webhook_dispatch, the mailing sweeps, payment_reconcile,
  // abandoned_orders, product_detourage…) runs through the SAME center the cron
  // uses — synchronous, logged (trigger "manual"), throw-safe, and bypassing the
  // kill-switch (an explicit operator run always executes).
  if (isCentralizedJob(jobKey)) {
    const res = await runScheduledJob(jobKey, "manual");
    await bus.emit("job.run_triggered", { jobKey }, { actorUserId: session.user.id });
    revalidatePath(JOBS_PATH);
    if (res.status === "failed") {
      return { ok: false, message: `Échec — ${res.summary ?? "voir le journal d'exécution"}.` };
    }
    return { ok: true, message: `Exécutée${res.summary ? ` — ${res.summary}` : ""}.` };
  }

  return { ok: false, message: "Tâche inconnue." };
}
