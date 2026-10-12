import { NextResponse, after } from "next/server";

import { guardCron } from "@/lib/cron/guard";
import { runScheduledJob } from "@/lib/jobs/run-job";
import { SCHEDULED_JOBS } from "@/lib/jobs/registry";
import { isDispatchable, isJobDue } from "@/lib/jobs/dispatch-schedule";
import { jobRunLogService } from "@/modules/jobs";

/**
 * THE single cron heartbeat. Point ONE Coolify Scheduled Task at this (every ~2 min):
 *
 *   POST /api/cron/dispatch   Authorization: Bearer <CRON_SECRET>
 *
 * It reads the last run of each externally-scheduled job, computes which are DUE
 * from their machine cadence (SCHEDULED_JOBS[].dispatch), and runs them through the
 * SHARED `runScheduledJob` center — so each still honours its own kill-switch +
 * logs its own row exactly as if it had its own cron. This replaces the separate
 * per-job Coolify crons; the per-job routes still exist (manual curl / run-now
 * parity), only the SCHEDULE collapses to one task.
 *
 * Runs due jobs SEQUENTIALLY in a background `after()` sweep (bounded resource use;
 * each is wall-clock bounded by withJobTimeout in run-job.ts). An in-process lock
 * skips a new tick while the previous sweep is still running, so a slow drain can't
 * stack overlapping runs on the single standalone instance.
 */
export const dynamic = "force-dynamic";

/** The self-bounding queue drains — run LAST in the sweep (they may run minutes). */
const LONG_DRAIN_KEYS = new Set(["mailing_queue", "webhook_dispatch"]);

let dispatchInFlight = false;

export async function POST(request: Request) {
  const denied = await guardCron(request);
  if (denied) return denied;

  if (dispatchInFlight) {
    return NextResponse.json({ ok: true, skipped: "already_running" });
  }
  // CLAIM THE LOCK BEFORE THE FIRST `await`. JS is single-threaded, so with no await
  // between the guard above and this assignment the check-and-set is ATOMIC — two
  // heartbeats arriving in the same tick cannot both observe `false`. If the claim sat
  // AFTER `await lastRunByJob`, two overlapping POSTs (a Coolify retry on a slow tick,
  // or an operator curl racing the cron) would both read the SAME never-yet-recorded
  // last-run snapshot and both run the ENTIRE due list — double-sending mail / birthday
  // codes on any job that isn't strictly claim-then-act.
  dispatchInFlight = true;
  try {
    const jobs = SCHEDULED_JOBS.filter((j) => isDispatchable(j.dispatch));
    // FAIL SAFE, NOT FAIL OPEN. The last-executed map is the ONLY thing that says a job
    // already ran; `.catch(() => new Map())` would make every job look never-run, so a
    // single transient DB blip fires the WHOLE schedule at once — re-sending mail,
    // re-sweeping orders. Skipping this tick is always safe (the next one is minutes away
    // and re-reads the log); running everything is not.
    //
    // Anchor on the last EXECUTED run (ok / no-op skipped), NOT the last run of any
    // status: a transient `failed` run is ignored so the job retries on the next tick
    // instead of being suppressed until its next cadence slot (a daily job would lose the
    // whole day). A kill-switch-disabled job writes no row (run-job.ts), so a paused-then-
    // re-enabled job runs the same day. `lastRunByJob` (any status) still drives the dashboard.
    const last = await jobRunLogService.lastExecutedRunByJob(jobs.map((j) => j.key)).catch((err) => {
      console.error("[cron] lastExecutedRunByJob unavailable — skipping this tick", err);
      return null;
    });
    if (last === null) {
      dispatchInFlight = false;
      return NextResponse.json({ ok: true, skipped: "lastrun_unavailable" });
    }
    const now = Date.now();
    const due = jobs.filter((j) => {
      // Cadence is measured START-to-START (started_at), not from the run's finish, so a
      // drain that occupies most of its period keeps full rate (the INTERVAL_SLACK alone
      // can't fix a finish-based anchor — a 110s drain on a 2-min beat would halve).
      const startedAt = last.get(j.key)?.started_at;
      return isJobDue(j.dispatch, startedAt ? new Date(startedAt).getTime() : null, now);
    });
    if (due.length === 0) {
      dispatchInFlight = false;
      return NextResponse.json({ ok: true, dispatched: 0, keys: [] });
    }

    // Run the due jobs AFTER the response is sent. A cron heartbeat MUST return fast: the
    // external scheduler kills the call at its timeout, so a slow FIRST tick (every job
    // due at once) or one slow job must never hold the request open. Each job is
    // wall-clock bounded (withJobTimeout) AND throw-safe (runScheduledJob), so the
    // background sweep always finishes and releases the in-flight lock; the next tick
    // skips while it runs. Outcomes land in job_run_log (the Tâches planifiées dashboard).
    //
    // Order: the quick jobs FIRST, then the two self-bounding queue drains (which may
    // legitimately run for minutes — see JOB_TIMEOUT_OVERRIDES_MS) LAST, so a slow drain
    // can't delay the quick jobs (payment reconcile, abandoned-order sweep…) due this tick.
    const ordered = [...due].sort(
      (a, b) => Number(LONG_DRAIN_KEYS.has(a.key)) - Number(LONG_DRAIN_KEYS.has(b.key)),
    );
    after(async () => {
      try {
        for (const job of ordered) {
          await runScheduledJob(job.key, "cron");
        }
      } finally {
        dispatchInFlight = false;
      }
    });

    return NextResponse.json({ ok: true, scheduled: due.length, keys: due.map((j) => j.key) });
  } catch (err) {
    // Any synchronous throw before after() is scheduled must release the claim, or the
    // endpoint would wedge on "already_running" until the process restarts.
    dispatchInFlight = false;
    throw err;
  }
}
