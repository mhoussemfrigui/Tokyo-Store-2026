import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { cart_events, type CartActorKind } from "./schema";

// Batch size for the retention purge — keeps each DELETE a short, self-contained
// statement well under the role's statement_timeout even on a multi-million-row
// table (cart_events is one of the highest-write tables). Mirrors AuditService.
const PURGE_BATCH_SIZE = 5000;

export type TopAddedRow = {
  productId: string;
  units: number;
  events: number;
  clientUnits: number;
  visitorUnits: number;
};

class CartEventService {
  /** Append one add-to-cart event. Best-effort — callers ignore failures so a
   *  telemetry hiccup never blocks the cart add. */
  async record(input: {
    productId: string;
    variantId?: string | null;
    quantity: number;
    actorKind: CartActorKind;
    source?: "cart" | "quick_add";
  }): Promise<void> {
    // Clamp to the SAME bound the add-to-cart workflow enforces (1–99) — the raw
    // client quantity reaching here is untrusted, and an uncapped value would
    // skew the most-added-to-cart units beyond what actually entered the cart.
    const quantity = Math.min(99, Math.max(1, Math.trunc(input.quantity) || 1));
    await db.insert(cart_events).values({
      product_id: input.productId,
      variant_id: input.variantId ?? "",
      quantity,
      actor_kind: input.actorKind,
      source: input.source ?? "cart",
    });
  }

  /**
   * Most-added-to-cart products over the last `sinceDays`, ranked by units,
   * with the client vs visitor split per product. Backed by
   * `cart_events_occurred_idx` (window scan) → grouped aggregate.
   */
  async topAdded(opts: { sinceDays: number; limit?: number }): Promise<TopAddedRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
    const rows = await db
      .select({
        productId: cart_events.product_id,
        units: sql<number>`sum(${cart_events.quantity})::int`,
        events: sql<number>`count(*)::int`,
        clientUnits: sql<number>`coalesce(sum(${cart_events.quantity}) filter (where ${cart_events.actor_kind} = 'client'), 0)::int`,
        visitorUnits: sql<number>`coalesce(sum(${cart_events.quantity}) filter (where ${cart_events.actor_kind} = 'visitor'), 0)::int`,
      })
      .from(cart_events)
      .where(sql`${cart_events.occurred_at} >= now() - make_interval(days => ${opts.sinceDays})`)
      .groupBy(cart_events.product_id)
      .orderBy(sql`sum(${cart_events.quantity}) desc`)
      .limit(limit);
    return rows.map((r) => ({
      productId: r.productId,
      units: Number(r.units),
      events: Number(r.events),
      clientUnits: Number(r.clientUnits),
      visitorUnits: Number(r.visitorUnits),
    }));
  }

  /**
   * Retention purge — drop add events older than `days`. Returns rows removed.
   * Deletes in `PURGE_BATCH_SIZE` chunks until a round removes < a full batch,
   * each chunk a self-contained committed statement counted via a RETURNING-1 CTE
   * (no id list crosses the wire). Backed by `cart_events_occurred_idx` for the
   * cutoff sub-select — avoids the WAL flood / long lock / statement-timeout of a
   * single unbounded DELETE on a high-write table.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let total = 0;
    for (;;) {
      const result = await db.execute<{ count: number }>(sql`
        WITH del AS (
          DELETE FROM cart_events
          WHERE id IN (
            SELECT id FROM cart_events
            WHERE occurred_at < ${cutoff}
            ORDER BY occurred_at
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

export const cartEventService = new CartEventService();
