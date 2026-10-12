import "server-only";

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { resolveJobRunStatus } from "@/lib/jobs/outcome";
import {
  job_run_log,
  type JobRunLogRow,
  type JobRunStatus,
  type JobRunTrigger,
} from "./schema";

/** Real (ok / failed) runs kept per job_key by the prune-on-record. */
const KEEP_PER_JOB = 100;
/**
 * `skipped` rows kept per job_key — no-op runs (« file vide » drains every ~2 min
 * that ran and found nothing to do). They prove the external cron fires, so they ARE
 * recorded, but on their own budget: otherwise ~30/h of them would evict every real
 * run (and its failure) within ~3 h. (A kill-switch-DISABLED tick records no row at
 * all — see run-job.ts — so it can't pollute the dispatcher's executed-run anchor.)
 */
const KEEP_SKIPPED_PER_JOB = 20;

/**
 * Records + reads scheduled-job execution history. Every registered job logs a
 * row here via {@link runAndLog}; the admin dashboard reads it. Bounded by a
 * prune-on-record that keeps, per job_key, the latest {@link KEEP_PER_JOB} real
 * runs + the latest {@link KEEP_SKIPPED_PER_JOB} no-op runs + always the latest
 * failure (the retention TTL still bounds everything by age).
 */
class JobRunLogService {
  async record(input: {
    jobKey: string;
    status: JobRunStatus;
    trigger: JobRunTrigger;
    startedAt: Date;
    finishedAt?: Date;
    summary?: string | null;
    error?: string | null;
  }): Promise<void> {
    const finishedAt = input.finishedAt ?? new Date();
    await db.insert(job_run_log).values({
      job_key: input.jobKey,
      status: input.status,
      trigger: input.trigger,
      started_at: input.startedAt,
      finished_at: finishedAt,
      duration_ms: Math.max(0, finishedAt.getTime() - input.startedAt.getTime()),
      summary: input.summary?.slice(0, 1000) ?? null,
      error: input.error?.slice(0, 2000) ?? null,
    });
    // Pruning is housekeeping — never let it fail the run that was just logged
    // (a thrown prune would otherwise bubble through runAndLog's success path
    // and get mis-recorded as a job failure).
    await this.prune(input.jobKey).catch((e) => console.error("[jobs] prune failed", e));
  }

  /**
   * Run `fn`, timing it, and record one log row: on success `ok` (or the
   * `status` the result opts into, e.g. `skipped`) with the returned summary,
   * or `failed` with the error (re-thrown so the caller's own handling still
   * fires). The single place jobs hook into the history.
   */
  async runAndLog<
    T extends { summary?: string | null; status?: JobRunStatus; error?: string | null } | void,
  >(jobKey: string, trigger: JobRunTrigger, fn: () => Promise<T>): Promise<T> {
    const startedAt = new Date();
    try {
      const res = await fn();
      const r = res as
        | { summary?: string | null; status?: JobRunStatus; error?: string | null }
        | undefined;
      // A successful fn defaults to "ok" but may opt into "skipped" (no-op run)
      // or "failed" — the latter for a work fn that REPORTS failure by returning
      // {status:"failed"} rather than throwing (the scheduled-job work fns are
      // defensive and return result objects). A thrown error is recorded "failed" below.
      const status: JobRunStatus = resolveJobRunStatus(r);
      await this.record({
        jobKey,
        status,
        trigger,
        startedAt,
        summary: r?.summary ?? null,
        error: status === "failed" ? (r?.error ?? null) : null,
      });
      return res;
    } catch (err) {
      await this.record({
        jobKey,
        status: "failed",
        trigger,
        startedAt,
        error: err instanceof Error ? err.message : String(err),
      }).catch(() => {});
      throw err;
    }
  }

  /**
   * Bound a job_key's history: keep the latest `keep` real (non-skipped) runs,
   * the latest `keepSkipped` skipped (no-op) runs, and always the latest failed
   * run — so a burst of « file vide » heartbeats (or a long streak of ok runs)
   * can't evict the one failure an operator needs to see. A SINGLE
   * delete-with-subqueries (not select-then-delete) so a row inserted
   * concurrently by another run — internal scheduler, external cron, and manual
   * run-now all call record() — is either visible to both the subqueries and the
   * delete (kept) or to neither (untouched); there's no window in which a
   * just-recorded newest row falls outside a stale id snapshot and gets erased.
   * `id` (UUID v7, time-ordered) breaks created_at ties so the ordering is total.
   */
  async prune(
    jobKey: string,
    keep = KEEP_PER_JOB,
    keepSkipped = KEEP_SKIPPED_PER_JOB,
  ): Promise<void> {
    await db.execute(sql`
      delete from ${job_run_log}
      where ${job_run_log.job_key} = ${jobKey}
        and ${job_run_log.id} not in (
          select ${job_run_log.id} from ${job_run_log}
          where ${job_run_log.job_key} = ${jobKey} and ${job_run_log.status} <> 'skipped'
          order by ${job_run_log.created_at} desc, ${job_run_log.id} desc
          limit ${keep}
        )
        and ${job_run_log.id} not in (
          select ${job_run_log.id} from ${job_run_log}
          where ${job_run_log.job_key} = ${jobKey} and ${job_run_log.status} = 'skipped'
          order by ${job_run_log.created_at} desc, ${job_run_log.id} desc
          limit ${keepSkipped}
        )
        and ${job_run_log.id} not in (
          select ${job_run_log.id} from ${job_run_log}
          where ${job_run_log.job_key} = ${jobKey} and ${job_run_log.status} = 'failed'
          order by ${job_run_log.created_at} desc, ${job_run_log.id} desc
          limit 1
        )
    `);
  }

  /**
   * A job's history, newest first. `hideSkipped` drops the no-op runs so the
   * dashboard « Historique » can show the real runs behind a wall of « file
   * vide » heartbeats.
   */
  async listForJob(
    jobKey: string,
    limit = 20,
    opts: { hideSkipped?: boolean } = {},
  ): Promise<JobRunLogRow[]> {
    return db
      .select()
      .from(job_run_log)
      .where(
        opts.hideSkipped
          ? and(eq(job_run_log.job_key, jobKey), ne(job_run_log.status, "skipped"))
          : eq(job_run_log.job_key, jobKey),
      )
      .orderBy(desc(job_run_log.created_at), desc(job_run_log.id))
      .limit(limit);
  }

  /**
   * Recent runs across jobs (newest first). Pass `keys` to restrict to the
   * registered jobs so orphan/retired job_keys can't crowd out the real ones in
   * the dashboard's cross-job activity table. id (UUID v7) tiebreaks equal
   * created_at for a stable order.
   */
  async listRecent(limit = 50, keys?: string[]): Promise<JobRunLogRow[]> {
    return db
      .select()
      .from(job_run_log)
      .where(keys && keys.length > 0 ? inArray(job_run_log.job_key, keys) : undefined)
      .orderBy(desc(job_run_log.created_at), desc(job_run_log.id))
      .limit(limit);
  }

  /**
   * Latest run per job_key, for the dashboard summary line. Uses Postgres
   * DISTINCT ON so it returns exactly one row per key (not every row per key
   * deduped in JS); the (job_key, created_at DESC) index serves the ordering,
   * and id (UUID v7) DESC tiebreaks same-millisecond created_at deterministically.
   * Built with the query builder (not a raw `db.execute`) so the columns go
   * through Drizzle's decoders — a raw read returns timestamptz as STRINGS,
   * which broke the dashboard's `toJobRunView` (`started_at.toISOString()`).
   */
  async lastRunByJob(jobKeys: string[]): Promise<Map<string, JobRunLogRow>> {
    return this.latestPerJob(jobKeys);
  }

  /**
   * Latest run per job_key that ACTUALLY EXECUTED — status `ok` or `skipped`
   * (a no-op run), never `failed`. This is the dispatcher's due-ness ANCHOR
   * (not `lastRunByJob`): a transient `failed` run must NOT count as "ran this
   * period" — otherwise a daily job that throws would be suppressed until the
   * next day instead of retrying on the next tick. The dashboard still reads
   * `lastRunByJob` (any status) to SHOW the last run, incl. a failure.
   */
  async lastExecutedRunByJob(jobKeys: string[]): Promise<Map<string, JobRunLogRow>> {
    return this.latestPerJob(jobKeys, { not: "failed" });
  }

  /**
   * Latest FAILED run per job_key — the dashboard card's « Dernier échec », so a
   * failure stays visible after later no-op / ok runs replace it as the latest
   * run. The prune always keeps the latest failure per key, so it survives
   * until the age-based TTL.
   */
  async lastFailureByJob(jobKeys: string[]): Promise<Map<string, JobRunLogRow>> {
    return this.latestPerJob(jobKeys, { status: "failed" });
  }

  private async latestPerJob(
    jobKeys: string[],
    opts: { status?: JobRunStatus; not?: JobRunStatus } = {},
  ): Promise<Map<string, JobRunLogRow>> {
    const out = new Map<string, JobRunLogRow>();
    if (jobKeys.length === 0) return out;
    const base = inArray(job_run_log.job_key, jobKeys);
    const where = opts.status
      ? and(base, eq(job_run_log.status, opts.status))
      : opts.not
        ? and(base, ne(job_run_log.status, opts.not))
        : base;
    const rows = await db
      .selectDistinctOn([job_run_log.job_key])
      .from(job_run_log)
      .where(where)
      .orderBy(job_run_log.job_key, desc(job_run_log.created_at), desc(job_run_log.id));
    for (const r of rows) out.set(r.job_key, r);
    return out;
  }

  /**
   * Age-based purge of the whole table, regardless of job_key — the per-key
   * KEEP_PER_JOB prune only fires when THAT key is recorded again, so a removed
   * or renamed job's rows would otherwise linger forever. Called from the daily
   * retention sweep. Unbatched is fine: the table is bounded to ~100 rows/key.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const res = await db.execute<{ count: number }>(sql`
      with del as (
        delete from ${job_run_log}
        where ${job_run_log.created_at} < now() - make_interval(days => ${days})
        returning 1
      )
      select count(*)::int as count from del;
    `);
    return Number(res.rows[0]?.count ?? 0);
  }
}

export const jobRunLogService = new JobRunLogService();
