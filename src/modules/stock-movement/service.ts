import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { keysetAfter, keysetCursor, settledBefore } from "@/lib/api/keyset";
import { stock_movements, type StockMovementReason, type StockMovementRow } from "./schema";

/**
 * Append-only stock-movement ledger writer. `record` is safe to call inside the
 * SAME tx as the mutation it logs (pass `tx`); it's a plain insert that never
 * throws a unique/constraint surprise. Every quantity-changing path appends one
 * row: order sale, cancellation, return-receive, external API delta/set, and
 * product- AND variant-level admin edits. Opening balances are intentionally
 * NOT ledgered, so the reconstructable quantity is the NET change since a
 * baseline.
 *
 * (The reader methods for a future reconciliation/audit UI were removed as
 * unused; rebuild them from `sum(delta)` when that surface is actually built.)
 */
class StockMovementService {
  async record(
    input: {
      productId: string;
      variantId?: string | null;
      delta: number;
      resultingQty?: number | null;
      reason: StockMovementReason;
      orderId?: string | null;
      /** Stock location the change happened at (multi-location); null = pool. */
      locationId?: string | null;
      actorUserId?: string | null;
      note?: string | null;
    },
    txOrDb: DbOrTx = db,
  ): Promise<void> {
    await txOrDb.insert(stock_movements).values({
      product_id: input.productId,
      variant_id: input.variantId ?? null,
      delta: input.delta,
      resulting_qty: input.resultingQty ?? null,
      reason: input.reason,
      order_id: input.orderId ?? null,
      location_id: input.locationId ?? null,
      actor_user_id: input.actorUserId ?? null,
      note: input.note ?? null,
    });
  }

  /**
   * Incremental-sync read of the append-only ledger for the external API — ASC
   * `(created_at, id)` keyset (created_at is the change axis). Filter by product,
   * variant, order, or reason. A bare `since` (no id) is an inclusive watermark.
   * Powers `/api/stock/movements`. (This is the reader the record-only note above
   * anticipated — kept keyset-paginated + bounded so a big ledger stays cheap.)
   * Shared µs keyset + settle window (`@/lib/api/keyset`): one tx records many
   * movements with the SAME `now()`, so a ms cursor would loop on them forever.
   */
  async listForApi(
    opts: {
      productId?: string;
      variantId?: string;
      orderId?: string;
      reason?: StockMovementReason;
      sinceIso?: string;
      sinceId?: string;
      limit?: number;
      /** Settle window override (seconds); 0 only for tests. */
      settleSeconds?: number;
    } = {},
  ): Promise<{ items: StockMovementRow[]; nextSince: string | null; nextId: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const conditions = [];
    if (opts.productId) conditions.push(eq(stock_movements.product_id, opts.productId));
    if (opts.variantId) conditions.push(eq(stock_movements.variant_id, opts.variantId));
    if (opts.orderId) conditions.push(eq(stock_movements.order_id, opts.orderId));
    if (opts.reason) conditions.push(eq(stock_movements.reason, opts.reason));
    const after = keysetAfter(stock_movements.created_at, stock_movements.id, opts.sinceIso, opts.sinceId);
    if (after) conditions.push(after);
    const settled = settledBefore(stock_movements.created_at, opts.settleSeconds);
    if (settled) conditions.push(settled);
    const rows = await db
      .select({ row: stock_movements, cursor: keysetCursor(stock_movements.created_at) })
      .from(stock_movements)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(stock_movements.created_at), asc(stock_movements.id))
      .limit(limit);
    const last = rows[rows.length - 1];
    return {
      items: rows.map((r) => r.row),
      nextSince: last ? last.cursor : null,
      nextId: last ? last.row.id : null,
    };
  }
}

export const stockMovementService = new StockMovementService();
