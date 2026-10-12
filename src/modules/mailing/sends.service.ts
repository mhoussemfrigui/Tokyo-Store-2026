import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { mailing_sends, type NewMailingSendRow } from "./schema";

/**
 * Per-(flow, dedup_key) idempotency ledger for automations. `claimOnce` inserts
 * FIRST and reports whether THIS caller won the row — so a flow fires exactly
 * once per natural key across cron re-runs, crash-retries, and concurrent ticks
 * (the unique index serialises the race). Kept separate from `email_logs` (which
 * is retention-pruned) so the correctness key is never mis-pruned.
 */
class MailingSendsService {
  /** Returns true if THIS call inserted the row (first time → proceed); false if it already existed. */
  async claimOnce(flowKey: string, dedupKey: string): Promise<boolean> {
    const rows = await db
      .insert(mailing_sends)
      .values({ flow_key: flowKey, dedup_key: dedupKey } as NewMailingSendRow)
      .onConflictDoNothing()
      .returning({ id: mailing_sends.id });
    return rows.length > 0;
  }

  /**
   * Give a claim back — for a send that was claimed but NOT enqueued (the
   * dispatch was skipped: marketing kill-switch, template disabled, recipient
   * opted out). Without it the natural key stays burned, so re-enabling the flow
   * and re-running (e.g. the same day's birthday job) would send nothing.
   */
  async release(flowKey: string, dedupKey: string): Promise<void> {
    await db
      .delete(mailing_sends)
      .where(and(eq(mailing_sends.flow_key, flowKey), eq(mailing_sends.dedup_key, dedupKey)));
  }

  /**
   * Age-based purge (daily retention sweep) — the ledger would otherwise grow
   * unbounded. Safe once a dedup window has closed: birthday keys are year-scoped
   * (the past year never re-fires), price-drop keys are price-scoped, and a promo
   * old enough to purge won't be re-announced. Default window ≫ any real window.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const res = await db.execute<{ count: number }>(sql`
      with del as (
        delete from ${mailing_sends}
        where ${mailing_sends.created_at} < now() - make_interval(days => ${days})
        returning 1
      )
      select count(*)::int as count from del;
    `);
    return Number(res.rows[0]?.count ?? 0);
  }
}

export const mailingSendsService = new MailingSendsService();
