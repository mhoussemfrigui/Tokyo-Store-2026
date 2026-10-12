import "server-only";

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  import_jobs,
  type DataJobResult,
  type DataOperation,
  type DataSegment,
  type DataSource,
  type ImportJobFormat,
  type ImportJobRow,
} from "./schema";

// `source_content` (the raw uploaded feed body) is never projected to the admin
// panel — it's NULLed on completion and can be large.
export type DataJobView = Omit<ImportJobRow, "source_content">;

type NewDataJobInput = {
  operation?: DataOperation;
  segment?: DataSegment;
  source?: DataSource;
  title?: string;
  format?: ImportJobFormat | null;
  filename?: string | null;
  source_content?: string | null;
  created_by: string;
};

/**
 * Transaction-scoped advisory-lock key serialising every job START (upload
 * import, data-job, détourage reprocess, the demo relaunch's feed import). An
 * xact lock is released on COMMIT/ROLLBACK, so it is safe behind the
 * transaction-pooling PgBouncer and needs no schema change.
 */
const SINGLE_FLIGHT_LOCK = "import_jobs_single_flight";

const ACTIVE_STATUSES = ["queued", "running"] as const;

/**
 * Data-job CRUD (import + clean). Single-module (no cross-module imports) per
 * the module rules — the runner workflow orchestrates the actual writes.
 */
export const importJobService = {
  async create(input: NewDataJobInput): Promise<ImportJobRow> {
    const [row] = await db.insert(import_jobs).values(input).returning();
    return row;
  },

  /**
   * ATOMIC single-flight create: inside ONE transaction holding the
   * cluster-wide `pg_advisory_xact_lock`, re-check that no job is queued/running
   * and only then insert the `queued` row. Two near-simultaneous starts
   * serialise on the lock, so the second one sees the first's committed row
   * (READ COMMITTED takes a fresh snapshot per statement) and gets `null` —
   * the caller maps that to its « déjà en cours » refusal. The plain
   * `hasActive()` pre-check callers keep is only a fast path; this is the gate.
   */
  async createIfIdle(input: NewDataJobInput): Promise<ImportJobRow | null> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${SINGLE_FLIGHT_LOCK}))`);
      const [active] = await tx
        .select({ id: import_jobs.id })
        .from(import_jobs)
        .where(inArray(import_jobs.status, [...ACTIVE_STATUSES]))
        .limit(1);
      if (active) return null;
      const [row] = await tx.insert(import_jobs).values(input).returning();
      return row;
    });
  },

  async findById(id: string): Promise<ImportJobRow | null> {
    const [row] = await db.select().from(import_jobs).where(eq(import_jobs.id, id)).limit(1);
    return row ?? null;
  },

  /** Most recent jobs for the admin panel (source_content excluded — it can
   *  be megabytes and the panel never needs it). Optionally filter by
   *  operation so the import page and the cleanup card show distinct lists. */
  async listRecent(
    limit = 20,
    filter: { operation?: DataOperation } = {},
  ): Promise<DataJobView[]> {
    const where = filter.operation ? eq(import_jobs.operation, filter.operation) : undefined;
    const rows = await db
      .select({
        id: import_jobs.id,
        operation: import_jobs.operation,
        segment: import_jobs.segment,
        source: import_jobs.source,
        title: import_jobs.title,
        format: import_jobs.format,
        filename: import_jobs.filename,
        status: import_jobs.status,
        processed: import_jobs.processed,
        total: import_jobs.total,
        result: import_jobs.result,
        error: import_jobs.error,
        created_by: import_jobs.created_by,
        started_at: import_jobs.started_at,
        finished_at: import_jobs.finished_at,
        created_at: import_jobs.created_at,
        updated_at: import_jobs.updated_at,
      })
      .from(import_jobs)
      .where(where)
      .orderBy(desc(import_jobs.created_at))
      .limit(limit);
    return rows;
  },

  /** True when a job is queued or running — the action refuses concurrent
   *  jobs (single-flight; the runner is CPU/network heavy and many ops touch
   *  overlapping tables). */
  async hasActive(): Promise<boolean> {
    const [row] = await db
      .select({ id: import_jobs.id })
      .from(import_jobs)
      .where(inArray(import_jobs.status, [...ACTIVE_STATUSES]))
      .limit(1);
    return Boolean(row);
  },

  /**
   * Stamp `result.cacheBustedAt` on the given FINISHED jobs that carry a result
   * and no stamp yet — the pollers call this right after busting the
   * storefront caches from a live request, so each finished job is busted once
   * (see `bustStorefrontForFinishedJobs`). Conditional + atomic: a concurrent
   * poller that already stamped a job gets it filtered out. Returns the ids
   * actually stamped. `updated_at` is left alone (terminal rows only).
   */
  async markCacheBusted(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await db
      .update(import_jobs)
      .set({
        result: sql`${import_jobs.result} || jsonb_build_object('cacheBustedAt', now())`,
      })
      .where(
        and(
          inArray(import_jobs.id, ids),
          inArray(import_jobs.status, ["completed", "failed"]),
          isNotNull(import_jobs.result),
          sql`(${import_jobs.result} ->> 'cacheBustedAt') IS NULL`,
        ),
      )
      .returning({ id: import_jobs.id });
    return rows.map((r) => r.id);
  },

  /**
   * Finished jobs of ANY operation (import / clean / détourage reprocess) that
   * carry a result but no `cacheBustedAt` stamp yet — every admin job surface
   * hands these to `bustStorefrontForFinishedJobs`, so a job no poller watched
   * to the end (a reprocess the operator walked away from) is still busted by
   * the next job page / poll. Only jobs finished within the last day: every
   * storefront `'use cache'` read uses `cacheLife("hours")` (expire = 1 day),
   * so an older job can't have a stale entry left to bust.
   */
  async listFinishedUnbusted(
    limit = 20,
  ): Promise<Array<Pick<ImportJobRow, "id" | "status" | "result">>> {
    return db
      .select({ id: import_jobs.id, status: import_jobs.status, result: import_jobs.result })
      .from(import_jobs)
      .where(
        and(
          inArray(import_jobs.status, ["completed", "failed"]),
          isNotNull(import_jobs.result),
          sql`(${import_jobs.result} ->> 'cacheBustedAt') IS NULL`,
          sql`${import_jobs.finished_at} > now() - interval '1 day'`,
        ),
      )
      .orderBy(desc(import_jobs.finished_at))
      .limit(limit);
  },

  async markRunning(id: string, total: number): Promise<void> {
    await db
      .update(import_jobs)
      .set({ status: "running", total, started_at: sql`now()`, updated_at: sql`now()` })
      .where(eq(import_jobs.id, id));
  },

  async updateProgress(id: string, processed: number): Promise<void> {
    await db
      .update(import_jobs)
      .set({ processed, updated_at: sql`now()` })
      .where(eq(import_jobs.id, id));
  },

  /** Terminal success — also drops the (potentially multi-MB) source body. */
  async complete(id: string, processed: number, result: DataJobResult): Promise<void> {
    await db
      .update(import_jobs)
      .set({
        status: "completed",
        processed,
        result,
        source_content: null,
        finished_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(eq(import_jobs.id, id));
  },

  /** Terminal failure (parse error, unexpected throw). Partial `result` may
   *  still be attached so the operator sees what landed before the abort. */
  async fail(id: string, error: string, result?: DataJobResult): Promise<void> {
    await db
      .update(import_jobs)
      .set({
        status: "failed",
        error,
        result: result ?? null,
        source_content: null,
        finished_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(eq(import_jobs.id, id));
  },

  /** Boot-time janitor: a `running` job whose process died (deploy restart)
   *  would otherwise block the single-flight gate forever. */
  async failStaleRunning(olderThanMinutes = 15): Promise<number> {
    const rows = await db
      .update(import_jobs)
      .set({
        status: "failed",
        error: "Interrompu (redémarrage du serveur pendant l'import).",
        source_content: null,
        finished_at: sql`now()`,
        updated_at: sql`now()`,
      })
      .where(
        sql`${import_jobs.status} IN ('queued','running') AND ${import_jobs.updated_at} < now() - make_interval(mins => ${olderThanMinutes})`,
      )
      .returning({ id: import_jobs.id });
    return rows.length;
  },
};
