import "server-only";

import { jobRunLogService } from "@/modules/jobs";
import type { JobRunStatus, JobRunTrigger } from "@/modules/jobs/schema";
import { isEnabledSettingValue, jobRunHttpStatus } from "@/lib/jobs/outcome";
import { settingService } from "@/modules/cms/setting/service";
import { runRetentionPurge } from "@/lib/retention/run";
import { drainEmailQueue } from "@/lib/mailing/drain";
import { drainWebhookQueue } from "@/lib/webhooks/dispatch-drain";
import { runBirthdayEmails } from "@/lib/mailing/birthday/run";
import { runWishlistCampaignEmails } from "@/lib/mailing/wishlist-campaign/run";
import { runPromotionAnnounceSweep } from "@/lib/mailing/promotion-announce/run";
import { runReviewRequests } from "@/lib/mailing/review-request/run";
import { runScheduledProductDetourage } from "@/workflows/media/reprocess-product-white-bg";
import { workflows } from "@/workflows";

/**
 * THE central executor for the externally-scheduled jobs (the 11 jobs the single
 * `/api/cron/dispatch` heartbeat drives: retention_purge, mailing_queue,
 * webhook_dispatch, birthday_email,
 * wishlist_campaign_email, promotion_announce_sweep, review_request,
 * payment_reconcile, abandoned_orders, product_detourage). Both the cron HTTP
 * routes AND the dashboard "run now" go through `runScheduledJob`, so EVERY run —
 * cron or manual — is:
 *
 *   1. gated by a per-job admin kill-switch (`jobs.<key>.enabled` in
 *      site_settings; missing ⇒ enabled). A disabled job records a `skipped`
 *      row and never runs the work.
 *   2. wrapped in `jobRunLogService.runAndLog`, so a THROW (DB down, etc.) is
 *      caught and recorded as `failed` — previously the routes recorded AFTER
 *      the await, so a throw produced NO row (an invisible failure).
 *   3. normalised to one row per run (ok | skipped | failed) with a summary +
 *      error.
 */

type WorkResult = {
  status: JobRunStatus;
  summary: string | null;
  error: string | null;
  payload: Record<string, unknown>;
};

/** One adapter per externally-scheduled job → a normalised {status,summary,error,payload}. */
const JOB_WORK: Record<string, () => Promise<WorkResult>> = {
  retention_purge: async () => {
    const r = await runRetentionPurge();
    return {
      status: r.ok ? "ok" : "failed",
      summary: r.summary,
      error: r.ok ? null : JSON.stringify(r.errors).slice(0, 2000),
      payload: { deleted: r.deleted, errors: r.errors },
    };
  },
  mailing_queue: async () => {
    const r = await drainEmailQueue();
    return {
      status: r.ok ? (r.status === "skipped" ? "skipped" : "ok") : "failed",
      summary: r.summary,
      // A reported failure with 0 failed sends is a SYSTEMIC failure (e.g. settings
      // unavailable → nothing sent) — surface the real reason, not "échecs: 0".
      error: r.ok ? null : r.failed > 0 ? `échecs: ${r.failed}` : (r.summary ?? "échec"),
      payload: { sent: r.sent, failed: r.failed, requeued: r.requeued, skipped: r.skipped, paused: r.paused },
    };
  },
  webhook_dispatch: async () => {
    const r = await drainWebhookQueue();
    return {
      status: r.ok ? (r.status === "skipped" ? "skipped" : "ok") : "failed",
      summary: r.summary,
      error: r.ok ? null : r.failed > 0 ? `échecs: ${r.failed}` : (r.summary ?? "échec"),
      payload: { delivered: r.delivered, failed: r.failed, requeued: r.requeued },
    };
  },
  birthday_email: async () => {
    const r = await runBirthdayEmails();
    return {
      status: r.status === "skipped" ? "skipped" : r.ok ? "ok" : "failed",
      summary: r.summary,
      error: null,
      payload: {},
    };
  },
  wishlist_campaign_email: async () => {
    const r = await runWishlistCampaignEmails();
    return {
      status: r.status === "skipped" ? "skipped" : r.ok ? "ok" : "failed",
      summary: r.summary,
      error: null,
      payload: {},
    };
  },
  promotion_announce_sweep: async () => {
    const r = await runPromotionAnnounceSweep();
    return {
      status: r.status === "skipped" ? "skipped" : r.ok ? "ok" : "failed",
      summary: r.summary,
      error: null,
      payload: {},
    };
  },
  review_request: async () => {
    const r = await runReviewRequests();
    return {
      status: r.status === "skipped" ? "skipped" : r.ok ? "ok" : "failed",
      summary: r.summary,
      error: null,
      payload: {},
    };
  },
  payment_reconcile: async () => {
    const r = await workflows.order.reconcilePendingPayments({}, { actorUserId: null });
    return r.ok
      ? {
          status: "ok",
          summary: `${r.data.checked} vérifiée(s), ${r.data.settled} réglée(s), ${r.data.cancelled} annulée(s)`,
          error: null,
          payload: r.data,
        }
      : {
          status: "failed",
          summary: null,
          error: JSON.stringify({ error: r.error, message: r.message }).slice(0, 2000),
          payload: {},
        };
  },
  abandoned_orders: async () => {
    const r = await workflows.order.sweepAbandonedOrders({}, { actorUserId: null });
    return r.ok
      ? {
          status: "ok",
          summary: `${r.data.checked} en attente vérifiée(s), ${r.data.cancelled} annulée(s) (stock restitué)`,
          error: null,
          payload: r.data,
        }
      : {
          status: "failed",
          summary: null,
          error: JSON.stringify({ error: r.error, message: r.message }).slice(0, 2000),
          payload: {},
        };
  },
  product_detourage: async () => {
    const r = await runScheduledProductDetourage();
    return {
      status: r.status,
      summary: r.summary,
      error: r.status === "failed" ? r.summary : null,
      payload: { changed: r.changed, skipped: r.skipped, failed: r.failed },
    };
  },
};

/** True for the externally-scheduled jobs this module executes. */
export function isCentralizedJob(jobKey: string): boolean {
  return jobKey in JOB_WORK;
}

const enabledKey = (jobKey: string) => `jobs.${jobKey}.enabled`;

/**
 * Per-job kill-switch — a MISSING setting ⇒ enabled (a fresh deploy keeps every
 * job running). FAIL-OPEN on a read error too (never silently pause a job because
 * the settings read hiccupped), but LOG it so an admin's disable being ignored
 * due to DB trouble is visible to ops rather than masked.
 */
export async function isJobEnabled(jobKey: string): Promise<boolean> {
  try {
    const row = await settingService.findByKey(enabledKey(jobKey));
    return isEnabledSettingValue(row?.value);
  } catch (err) {
    console.error(`[jobs] kill-switch read failed for ${jobKey}; defaulting to enabled`, err);
    return true;
  }
}

export async function setJobEnabled(jobKey: string, enabled: boolean): Promise<void> {
  await settingService.upsert({
    key: enabledKey(jobKey),
    value: enabled ? "true" : "false",
    type: "boolean",
    group_key: "jobs",
    label: `Tâche planifiée « ${jobKey} »`,
    description: "Interrupteur de la tâche planifiée (tableau de bord Tâches planifiées).",
  });
}

/** Default wall-clock ceiling for a single job's work. The dispatch heartbeat runs
 *  due jobs SEQUENTIALLY in one background sweep, so an unbounded hang would stall
 *  every later due job (and never release the dispatch in-flight lock). */
const JOB_TIMEOUT_MS = 90_000;

/**
 * Per-job ceilings for the jobs whose DESIGNED run legitimately exceeds 90s.
 *
 * The two queue drains self-bound to their OWN budgets and leave the rest claimed
 * for the next tick's crash-recovery (mailing: drain.ts `DRAIN_BUDGET_MS` ≈ 10 min;
 * webhook: dispatch-drain.ts batch worst-case `ceil(BATCH_SIZE/CONCURRENCY) ×
 * DELIVERY_DEADLINE_MS` ≈ 12.5 min). So here the ceiling must sit ABOVE that budget —
 * a pure anti-hang backstop that fires only if the drain's own budget logic breaks.
 * At 90s a normal-but-slow drain (a gentle throttle alone paces a batch past 90s, or a
 * sluggish provider/endpoint) would be FALSE-recorded `failed` and its in-flight sends
 * orphaned — the drain is in fact working. These are the only jobs that run minutes by
 * design; the dispatcher also runs them LAST in the sweep (see the route) so a long
 * drain can't starve the quick jobs in the same tick.
 */
const JOB_TIMEOUT_OVERRIDES_MS: Record<string, number> = {
  mailing_queue: 11 * 60_000,
  webhook_dispatch: 13 * 60_000,
};

function jobTimeoutMs(jobKey: string): number {
  return JOB_TIMEOUT_OVERRIDES_MS[jobKey] ?? JOB_TIMEOUT_MS;
}

/**
 * Bound a job's work by its ceiling (default {@link JOB_TIMEOUT_MS}, or a
 * {@link JOB_TIMEOUT_OVERRIDES_MS} override). Promise.race can't CANCEL the underlying
 * work, but it frees the dispatcher so one hung job can't hold the whole sequential
 * tick; the orphaned job winds down via its own fetch/query AbortSignals + statement
 * timeouts, and a timed-out job is recorded `failed` (never an invisible hang).
 */
function withJobTimeout<T>(work: Promise<T>, jobKey: string): Promise<T> {
  const ms = jobTimeoutMs(jobKey);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`la tâche « ${jobKey} » a dépassé ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export type RunJobResult = {
  httpStatus: number;
  status: JobRunStatus;
  ok: boolean;
  summary: string | null;
  payload: Record<string, unknown>;
  disabled?: boolean;
};

/**
 * Execute one externally-scheduled job through the center: kill-switch → runAndLog
 * (catches throws) → one job_run_log row. Never throws; returns an HTTP-ready
 * envelope so the cron route and the run-now action share identical behaviour.
 */
export async function runScheduledJob(
  jobKey: string,
  trigger: JobRunTrigger,
): Promise<RunJobResult> {
  const work = JOB_WORK[jobKey];
  if (!work) {
    return { httpStatus: 404, status: "failed", ok: false, summary: null, payload: { error: "tâche inconnue" } };
  }

  // The kill-switch pauses AUTOMATIC (cron) runs only — a manual "run now" from the
  // dashboard is an explicit operator action and always executes. A paused job records
  // NO job_run_log row: the dispatcher anchors due-ness on the last EXECUTED run
  // (lastExecutedRunByJob), so a disabled-skip row would count as "ran this period" and,
  // for a daily job, suppress the run on the SAME day it is re-enabled. With no row,
  // re-enabling runs it at the next due tick. (The dashboard shows « En pause » + the
  // last real run — it needs no paused-tick heartbeat.)
  if (trigger === "cron" && !(await isJobEnabled(jobKey))) {
    return { httpStatus: 200, status: "skipped", ok: true, summary: "désactivée", payload: {}, disabled: true };
  }

  let outcome: WorkResult;
  try {
    outcome = await jobRunLogService.runAndLog(jobKey, trigger, async () => {
      const r = await withJobTimeout(work(), jobKey);
      return { status: r.status, summary: r.summary, error: r.error, payload: r.payload };
    });
  } catch (err) {
    // runAndLog already recorded a "failed" row and re-threw — surface it.
    outcome = {
      status: "failed",
      summary: null,
      error: err instanceof Error ? err.message : String(err),
      payload: {},
    };
  }

  return {
    httpStatus: jobRunHttpStatus(outcome.status),
    status: outcome.status,
    ok: outcome.status !== "failed",
    summary: outcome.summary,
    payload: outcome.payload ?? {},
  };
}
