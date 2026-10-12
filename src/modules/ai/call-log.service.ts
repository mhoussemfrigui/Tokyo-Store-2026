import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { ai_call_logs, type NewAiCallLogRow } from "./schema";

/**
 * The AI call log (`ai_call_logs`, migration 0111) — an append-only, transport-level
 * record of provider calls. Today only the EMBEDDING chokepoint (`src/lib/ai/embed.ts`)
 * appends here; the `generateText` chat chokepoint does not log yet (future wiring).
 * Best-effort: a logging failure must NEVER surface in the calling path. With
 * semantic search on, embeddings append
 * at search/backfill rate, so the table is bounded by the daily retention cron
 * (`runRetentionPurge` → `purgeOlderThan(RETENTION_WINDOWS.ai_call_logs)`), exactly
 * like `search_log`. Write-only today: rows exist for retention accounting + ad-hoc
 * SQL inspection; there is no admin read view, so the service exposes only `append`
 * and `purgeOlderThan`.
 */
/** Rows deleted per round of the batched purge (bounds WAL + stays under the role's
 *  statement_timeout on a large table — same rationale as SearchService.purgeOlderThan). */
const PURGE_BATCH_SIZE = 5000;

class AiCallLogService {
  /** Append one call record. Swallows all errors (logging is never load-bearing). */
  async append(row: NewAiCallLogRow): Promise<void> {
    await db
      .insert(ai_call_logs)
      .values({ ...row, error: row.error?.slice(0, 1000) ?? null })
      .catch(() => {});
  }

  /**
   * Retention sweep — hard-delete rows older than `days`, BATCHED (no unbounded
   * `DELETE ... WHERE created_at < cutoff`) so each statement commits a bounded WAL
   * segment and stays under the 10s statement_timeout on a hot table. Returns the
   * total rows removed. Called by the daily `/api/cron/retention` sweep.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const d = Math.max(1, Math.min(days, 730));
    const cutoff = new Date(Date.now() - d * 86_400_000);
    let total = 0;
    for (;;) {
      const result = await db.execute<{ count: number }>(sql`
        WITH deleted AS (
          DELETE FROM ai_call_logs
          WHERE id IN (
            SELECT id FROM ai_call_logs WHERE created_at < ${cutoff} LIMIT ${PURGE_BATCH_SIZE}
          )
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM deleted;
      `);
      const removed = Number(result.rows[0]?.count ?? 0);
      total += removed;
      if (removed < PURGE_BATCH_SIZE) break;
    }
    return total;
  }
}

export const aiCallLogService = new AiCallLogService();
