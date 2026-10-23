import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { products, product_variants } from "@/modules/catalog/product/schema";

import { stock_reservations, type StockReservationRow } from "./schema";

/**
 * Stock-reservation service — the ONE primitive that maintains the cached
 * `reserved_qty` counters in lock-step with the `stock_reservations` ledger (as
 * `stock_qty` caches SUM(stock_levels.qty)). Used by the précommande flow:
 * placement RESERVES, conversion CONSUMES (caller decrements real stock),
 * cancel/refund RELEASES (nothing was decremented, so no restock). Every method
 * takes the caller's transaction so the counter and the ledger commit together.
 */
export const stockReservationService = {
  /** Open a hold for a preorder order line + bump the cached reserved_qty (the
   *  variant when `variantId` is set — per-variant stock — else the product pool). */
  async reserveForOrderLine(
    tx: DbOrTx,
    r: {
      orderId: string;
      orderItemId: string;
      productId: string;
      variantId: string | null;
      qty: number;
      actorUserId?: string | null;
    },
  ): Promise<void> {
    if (r.qty <= 0) return;
    await tx.insert(stock_reservations).values({
      order_id: r.orderId,
      order_item_id: r.orderItemId,
      product_id: r.productId,
      variant_id: r.variantId,
      qty: r.qty,
      state: "open",
      actor_user_id: r.actorUserId ?? null,
    });
    await bumpReserved(tx, r.productId, r.variantId, r.qty);
  },

  /** OPEN holds of an order (for cancel / refund / conversion reads). */
  async listOpenForOrder(tx: DbOrTx, orderId: string): Promise<StockReservationRow[]> {
    return tx
      .select()
      .from(stock_reservations)
      .where(and(eq(stock_reservations.order_id, orderId), eq(stock_reservations.state, "open")));
  },

  /** Release every OPEN hold of an order (cancel / refund BEFORE conversion):
   *  drop them out of reserved_qty + mark released. NO stock is restored — the
   *  reserved units were never decremented. Returns the number of holds released. */
  async releaseForOrder(tx: DbOrTx, orderId: string): Promise<number> {
    return settle(tx, orderId, "released");
  },

  /** Consume every OPEN hold of an order at CONVERSION: drop them out of
   *  reserved_qty + mark consumed. The caller decrements the real stock in the
   *  SAME tx (one decrement per returned hold). Returns the consumed holds. */
  async consumeForOrder(
    tx: DbOrTx,
    orderId: string,
  ): Promise<Array<{ productId: string; variantId: string | null; qty: number; orderItemId: string | null }>> {
    const open = await stockReservationService.listOpenForOrder(tx, orderId);
    await settle(tx, orderId, "consumed");
    return open.map((h) => ({
      productId: h.product_id,
      variantId: h.variant_id,
      qty: h.qty,
      orderItemId: h.order_item_id,
    }));
  },
};

async function bumpReserved(tx: DbOrTx, productId: string, variantId: string | null, delta: number): Promise<void> {
  if (variantId) {
    await tx
      .update(product_variants)
      .set({ reserved_qty: sql`greatest(0, ${product_variants.reserved_qty} + ${delta})` })
      .where(eq(product_variants.id, variantId));
  } else {
    await tx
      .update(products)
      .set({ reserved_qty: sql`greatest(0, ${products.reserved_qty} + ${delta})` })
      .where(eq(products.id, productId));
  }
}

/** Drop every OPEN hold of an order out of reserved_qty, then flip them to the
 *  terminal `state` ('released' | 'consumed') with a released_at stamp. */
async function settle(tx: DbOrTx, orderId: string, state: "released" | "consumed"): Promise<number> {
  const open = await stockReservationService.listOpenForOrder(tx, orderId);
  for (const h of open) await bumpReserved(tx, h.product_id, h.variant_id, -h.qty);
  if (open.length > 0) {
    await tx
      .update(stock_reservations)
      .set({ state, released_at: sql`now()`, updated_at: sql`now()` })
      .where(and(eq(stock_reservations.order_id, orderId), eq(stock_reservations.state, "open")));
  }
  return open.length;
}
