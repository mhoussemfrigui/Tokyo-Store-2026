import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { webhook_events } from "./schema";

export type WebhookProvider = "flouci" | "clictopay";

/**
 * Rows deleted per round of the batched purge. See `purgeOlderThan`.
 */
const PURGE_BATCH_SIZE = 5000;

/**
 * Idempotency ledger for payment webhooks. See `./schema` for the rationale.
 *
 * Usage in a webhook handler (after signature + amount verification, before
 * the status transition):
 *
 *   if (!(await webhookEventService.claim(provider, ref, target, order.id))) {
 *     return NextResponse.json({ ok: true, idempotent: true });
 *   }
 *   const result = await workflows.order.transitionStatus(...);
 *   if (!result.ok) await webhookEventService.release(provider, ref, target);
 */
class WebhookEventService {
  /**
   * Atomically claim an event for processing. Returns `true` when this call
   * inserted the row (caller should proceed), `false` when the event was
   * already claimed (caller should skip and return an idempotent 200). The
   * unique index serialises concurrent deliveries — only one wins the insert.
   */
  async claim(
    provider: WebhookProvider,
    eventRef: string,
    targetStatus: string,
    orderId?: string | null,
  ): Promise<boolean> {
    const rows = await db
      .insert(webhook_events)
      .values({
        provider,
        event_ref: eventRef,
        target_status: targetStatus,
        order_id: orderId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: webhook_events.id });
    return rows.length > 0;
  }

  /**
   * Release a previously-claimed event so a gateway retry can reprocess it.
   * Called only when the downstream transition FAILED — a successful claim of
   * a successful transition is left in place to dedupe future retries.
   */
  async release(
    provider: WebhookProvider,
    eventRef: string,
    targetStatus: string,
  ): Promise<void> {
    await db
      .delete(webhook_events)
      .where(
        and(
          eq(webhook_events.provider, provider),
          eq(webhook_events.event_ref, eventRef),
          eq(webhook_events.target_status, targetStatus),
        ),
      );
  }

  /**
   * Retention sweep — hard-delete idempotency-ledger rows older than `days`.
   * The ledger only needs to outlive a gateway's retry/replay window (hours,
   * not months), but it holds the `order_id` soft-FK so we keep a generous
   * default. PII-adjacent + unbounded growth → cron-purged.
   *
   * Batched in `PURGE_BATCH_SIZE` chunks (no unbounded `DELETE ... RETURNING`)
   * so each statement commits a bounded WAL segment and stays under the role's
   * 10s `statement_timeout`. The cutoff sub-select rides the
   * `webhook_events_created_at_brin` index. Returns the total rows removed.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let total = 0;
    for (;;) {
      const result = await db.execute<{ count: number }>(sql`
        WITH del AS (
          DELETE FROM webhook_events
          WHERE id IN (
            SELECT id FROM webhook_events
            WHERE created_at < ${cutoff}
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

export const webhookEventService = new WebhookEventService();
