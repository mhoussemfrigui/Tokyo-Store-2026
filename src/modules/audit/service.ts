import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { severityFor } from "@/events/severity";
import { audit_log, type NewAuditLogRow } from "./schema";

/**
 * Rows deleted per round of the batched purge. Keeps each DELETE small so it
 * commits a bounded WAL segment and stays well under the role's 10s
 * `statement_timeout` even on a multi-million-row table. See `purgeOlderThan`.
 */
const PURGE_BATCH_SIZE = 5000;

class AuditService {
  /**
   * Append-only. Never throws — audit failure must not break the originating
   * workflow (callers wrap in try/catch already; we add a defensive log here).
   */
  async record(entry: NewAuditLogRow): Promise<void> {
    try {
      // Severity is derived from the event name (single source of truth in
      // severity.ts). Subscribers pass it explicitly (they need it for their
      // capture gate); fill it here as a safety net for any direct caller so
      // the column is never left at the bare DB default for a non-info event.
      const values: NewAuditLogRow =
        entry.severity == null ? { ...entry, severity: severityFor(entry.event_name) } : entry;
      await db.insert(audit_log).values(values);
    } catch (err) {
      console.error("[audit] failed to record entry", { err, entry });
    }
  }

  /**
   * Hard-delete audit entries older than `days`. Append-only doesn't mean
   * infinite — admins need a way to drop legally-purgeable history. Returns
   * the total number of rows removed.
   *
   * Batched on purpose: a one-shot `DELETE ... RETURNING` over a full year
   * of rows would materialise every deleted id into JS just to `.length` it,
   * and write the whole deletion as a single transaction — flooding the WAL
   * and risking the pool's per-connection `statement_timeout` (10s default)
   * on a large table. Instead we
   * delete in `PURGE_BATCH_SIZE` chunks until a round removes nothing, each
   * chunk a self-contained committed statement counted via a RETURNING-1 CTE
   * (no id lists cross the wire). The `created_at` BRIN + DESC b-tree make
   * the cutoff sub-select cheap.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let total = 0;
    for (;;) {
      const result = await db.execute<{ count: number }>(sql`
        WITH del AS (
          DELETE FROM audit_log
          WHERE id IN (
            SELECT id FROM audit_log
            WHERE created_at < ${cutoff}
            ORDER BY created_at
            LIMIT ${PURGE_BATCH_SIZE}
          )
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM del;
      `);
      const deleted = Number(result.rows[0]?.count ?? 0);
      total += deleted;
      if (deleted < PURGE_BATCH_SIZE) break;
    }
    return total;
  }
}

export const auditService = new AuditService();
