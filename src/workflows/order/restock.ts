import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { type Tx } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { emitProductStockCacheBust } from "@/lib/catalog/product-cache-bust";
import { order_items } from "@/modules/order/schema";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { getSharedStockDefault, isSharedStock } from "@/lib/inventory/variant-stock";
import { stockMovementService, type StockMovementReason } from "@/modules/stock-movement";

/**
 * Return an order's line quantities to sellable stock — the exact mirror of the
 * place-order decrement. SHARED between the cancellation path
 * (transitionOrderStatusWorkflow) and the full-refund-of-an-UNSHIPPED-order path
 * (refundOrderWorkflow) so both restock IDENTICALLY:
 *  - SHARED-mode variable products restock the PARENT pool (mirrors placement),
 *  - rows locked in a deterministic global id order (no AB/BA deadlock under
 *    concurrent restocks sharing SKUs),
 *  - only TRACKED lines (`stock_qty IS NOT NULL`) on non-soft-deleted catalog
 *    rows are touched (an untracked product is never converted to tracked, a
 *    deleted catalog row is never resurrected),
 *  - re-enables `in_stock` ONLY when the line was actually SOLD OUT (`<= 0`); a
 *    deliberately-delisted but still-positive line stays delisted.
 *
 * QUANTITY: by default each line's FULL ordered quantity is restocked (the
 * cancel path — cancellation is only reachable pre-shipment). Pass
 * `opts.shippedByItem` (order_item_id → shipped qty) to restock only the
 * UNSHIPPED REMAINDER of each line (`quantity - shipped`, skipping lines with
 * nothing left): the full-refund path uses this so a partially-shipped order
 * returns only the units still in the warehouse. Shipped units are with the
 * customer and are recovered via the Returns (SAV) flow, which restocks the
 * physically-received quantities — so refund(remainder) + return(shipped)
 * together restore exactly the placed quantity, with no double-restock.
 *
 * STOCK MODE: pass `opts.sharedDefault` — the global variant-stock default,
 * resolved by the caller BEFORE it opened `tx` (like place-order / returns /
 * edit-items). Reading it in here would, on a cold cache, take a SECOND pool
 * connection while `tx` already holds one plus the order/stock row locks — at
 * pool-max concurrent cancels/refunds every tx waits on a connection that never
 * frees (pool deadlock until the acquire timeout). The in-tx fallback read only
 * exists for a caller that doesn't pass it.
 */
/**
 * What the restock touched — for the caller to emit catalog events AFTER commit:
 *  - `touchedProductIds`: every product whose stock row actually changed (drives
 *    `product.updated` → catalog/search cache bust);
 *  - `restockedProductIds`: products (or their variants) that crossed from sold-out
 *    (`<= 0`) back to a positive level (drives `product.restocked` → back-in-stock
 *    waitlist email). The crossing is derived from the returned NEW stock_qty minus
 *    the restocked quantity — no extra query.
 */
export type RestockOutcome = {
  touchedProductIds: string[];
  restockedProductIds: string[];
};

export async function restockOrderLines(
  tx: Tx,
  orderId: string,
  reason: StockMovementReason,
  actorUserId?: string | null,
  opts?: { shippedByItem?: Map<string, number>; sharedDefault?: boolean },
): Promise<RestockOutcome> {
  const touched = new Set<string>();
  const restocked = new Set<string>();
  const note = (productId: string, newQty: number | null, qty: number) => {
    touched.add(productId);
    if (newQty != null && newQty - qty <= 0 && newQty > 0) restocked.add(productId); // crossed sold-out → in stock
  };
  const lines = await tx
    .select({
      id: order_items.id,
      product_id: order_items.product_id,
      variant_id: order_items.variant_id,
      quantity: order_items.quantity,
    })
    .from(order_items)
    .where(eq(order_items.order_id, orderId));
  if (lines.length === 0) return { touchedProductIds: [], restockedProductIds: [] };

  const sharedDefault = opts?.sharedDefault ?? (await getSharedStockDefault());
  const lineProductIds = [...new Set(lines.map((l) => l.product_id))];
  const modeRows = lineProductIds.length
    ? await tx
        .select({ id: products.id, shared: products.shared_variant_stock })
        .from(products)
        .where(inArray(products.id, lineProductIds))
    : [];
  const sharedById = new Map(modeRows.map((r) => [r.id, r.shared]));
  const sharedOf = (pid: string) => isSharedStock(sharedById.get(pid), sharedDefault);

  // Deterministic global lock order (mirrors the placement decrement).
  const orderedLines = [...lines].sort((a, b) => {
    const ka = a.variant_id && !sharedOf(a.product_id) ? a.variant_id : a.product_id;
    const kb = b.variant_id && !sharedOf(b.product_id) ? b.variant_id : b.product_id;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  for (const line of orderedLines) {
    // Restock the full line qty by default; when shipped quantities are supplied
    // (full-refund path), restock only the unshipped remainder. A line with
    // nothing left to return (fully shipped, or a zero remainder) is skipped.
    const qty = opts?.shippedByItem
      ? Math.max(0, line.quantity - (opts.shippedByItem.get(line.id) ?? 0))
      : line.quantity;
    if (qty <= 0) continue;
    const shared = sharedOf(line.product_id);
    if (line.variant_id && !shared) {
      const r = await tx
        .update(product_variants)
        .set({
          stock_qty: sql`${product_variants.stock_qty} + ${qty}`,
          in_stock: sql`case when ${product_variants.stock_qty} <= 0 then true else ${product_variants.in_stock} end`,
        })
        .where(
          and(
            eq(product_variants.id, line.variant_id),
            sql`${product_variants.stock_qty} IS NOT NULL`,
            isNull(product_variants.deleted_at),
          ),
        )
        .returning({ stockQty: product_variants.stock_qty });
      if (r.length > 0) {
        note(line.product_id, r[0].stockQty, qty);
        await stockMovementService.record(
          { productId: line.product_id, variantId: line.variant_id, delta: qty, resultingQty: r[0].stockQty, reason, orderId, actorUserId },
          tx,
        );
      }
    } else {
      const r = await tx
        .update(products)
        .set({
          stock_qty: sql`${products.stock_qty} + ${qty}`,
          in_stock: sql`case when ${products.stock_qty} <= 0 then true else ${products.in_stock} end`,
        })
        .where(
          and(
            eq(products.id, line.product_id),
            sql`${products.stock_qty} IS NOT NULL`,
            isNull(products.deleted_at),
          ),
        )
        .returning({ stockQty: products.stock_qty });
      if (r.length > 0) {
        note(line.product_id, r[0].stockQty, qty);
        await stockMovementService.record(
          { productId: line.product_id, delta: qty, resultingQty: r[0].stockQty, reason, orderId, actorUserId },
          tx,
        );
      }
    }
  }
  return { touchedProductIds: [...touched], restockedProductIds: [...restocked] };
}

/**
 * Emit catalog events for a restock AFTER its tx commits (bus side effects must
 * not run inside the tx). `product.updated` busts the catalog/search cache; once
 * a product crossed back into stock, `product.restocked` drives the back-in-stock
 * waitlist email. Slugs (needed by product.updated) are fetched in ONE batch.
 * Shared by the cancel / full-refund / SAV-return restock paths.
 */
export async function emitRestockEvents(
  outcome: RestockOutcome,
  actorUserId?: string | null,
): Promise<void> {
  if (outcome.touchedProductIds.length === 0) return;
  // product.updated → catalog cache bust (shared helper; same path as
  // place-order + edit-items so the three stock-mutating flows can't drift).
  await emitProductStockCacheBust(outcome.touchedProductIds, actorUserId ?? null);
  // product.restocked → back-in-stock waitlist email (restock-specific).
  for (const productId of outcome.restockedProductIds) {
    await bus.emit("product.restocked", { productId }, { actorUserId: actorUserId ?? null });
  }
}
