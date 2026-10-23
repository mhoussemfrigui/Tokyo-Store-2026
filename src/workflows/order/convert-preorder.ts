import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db, type Tx } from "@/lib/db/client";
import { emitProductStockCacheBust } from "@/lib/catalog/product-cache-bust";
import { orders, order_items } from "@/modules/order/schema";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { stockMovementService } from "@/modules/stock-movement";
import { stockReservationService } from "@/modules/stock-reservation";
import { fail, ok, workflow } from "@/workflows/shared";

/**
 * Convert a précommande order at RELEASE — the deferred half of placement. A
 * preorder line claimed NO stock when the order was placed; it RESERVED units
 * instead (see place-order's reserve loop). Conversion is the moment the product
 * ships: CONSUME those holds (drops them out of `reserved_qty`) and decrement the
 * real `stock_qty` for each — exactly the decrement placement skipped — then flip
 * the lines to claimed/non-preorder and stamp `orders.preorder_converted_at`.
 *
 * The MIRROR of this (cancel / refund BEFORE conversion) RELEASES the holds with
 * no decrement — the units were never taken — see `stockReservationService.releaseForOrder`,
 * wired into transition-status (cancel) and refund-order.
 *
 * Idempotent: a non-preorder order, or one already converted, is a no-op. The
 * stock decrement uses `reason: "order"` — this IS the sale realizing, just
 * deferred from placement to release (there is no separate "preorder" ledger
 * reason; the holds are the preorder audit trail).
 */
export async function convertPreorderInTx(
  tx: Tx,
  orderId: string,
  actorUserId?: string | null,
): Promise<{ touchedProductIds: string[]; converted: boolean }> {
  // Lock the order; bail unless it's an unconverted preorder (idempotent).
  const [order] = await tx
    .select({
      id: orders.id,
      is_preorder: orders.is_preorder,
      converted_at: orders.preorder_converted_at,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .for("update")
    .limit(1);
  if (!order || !order.is_preorder || order.converted_at != null) {
    return { touchedProductIds: [], converted: false };
  }

  // Consume the open holds (drops them out of reserved_qty + marks consumed) and
  // decrement the real stock once per hold — the decrement placement deferred.
  const holds = await stockReservationService.consumeForOrder(tx, orderId);
  const touched = new Set<string>();
  for (const h of holds) {
    if (h.qty <= 0) continue;
    if (h.variantId) {
      // Per-variant stock (a hold only carries a variantId for non-shared stock).
      const r = await tx
        .update(product_variants)
        .set({
          stock_qty: sql`${product_variants.stock_qty} - ${h.qty}`,
          in_stock: sql`(${product_variants.stock_qty} - ${h.qty}) > 0`,
        })
        .where(
          and(
            eq(product_variants.id, h.variantId),
            sql`${product_variants.stock_qty} IS NOT NULL`,
            isNull(product_variants.deleted_at),
          ),
        )
        .returning({ stockQty: product_variants.stock_qty });
      if (r.length > 0) {
        touched.add(h.productId);
        await stockMovementService.record(
          { productId: h.productId, variantId: h.variantId, delta: -h.qty, resultingQty: r[0].stockQty, reason: "order", orderId, actorUserId },
          tx,
        );
      }
    } else {
      const r = await tx
        .update(products)
        .set({
          stock_qty: sql`${products.stock_qty} - ${h.qty}`,
          in_stock: sql`(${products.stock_qty} - ${h.qty}) > 0`,
        })
        .where(
          and(
            eq(products.id, h.productId),
            sql`${products.stock_qty} IS NOT NULL`,
            isNull(products.deleted_at),
          ),
        )
        .returning({ stockQty: products.stock_qty });
      if (r.length > 0) {
        touched.add(h.productId);
        await stockMovementService.record(
          { productId: h.productId, delta: -h.qty, resultingQty: r[0].stockQty, reason: "order", orderId, actorUserId },
          tx,
        );
      }
    }
  }

  // Flip the preorder lines to a regular (claimed, decremented) line + stamp the
  // order as converted so cancel/refund now RESTOCK instead of release.
  await tx
    .update(order_items)
    .set({ is_preorder: false, stock_claimed: true })
    .where(and(eq(order_items.order_id, orderId), eq(order_items.is_preorder, true)));
  await tx
    .update(orders)
    .set({ is_preorder: false, preorder_converted_at: sql`now()` })
    .where(eq(orders.id, orderId));

  return { touchedProductIds: [...touched], converted: true };
}

/**
 * Convert a single preorder order (admin "Convertir la précommande" on the order
 * page). One tx: consume holds → decrement stock → flip lines/order. Post-commit,
 * bust the catalog cache for every product whose stock moved.
 */
export const convertPreorderOrderWorkflow = workflow<
  [{ orderId: string }, { actorUserId?: string | null }],
  { touchedProductIds: string[]; converted: boolean }
>("order.convert_preorder", async (input, { actorUserId }) => {
  if (!input.orderId) return fail("validation", "Commande manquante.");
  const actor = actorUserId ?? null;
  const result = await db.transaction((tx) => convertPreorderInTx(tx, input.orderId, actor));
  if (result.touchedProductIds.length > 0) {
    await emitProductStockCacheBust(result.touchedProductIds, actor);
  }
  return ok(result);
});
