import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { resolveInventoryConfig } from "@/lib/inventory/locations-config";
import { resolveSharedStockProductIds } from "@/lib/inventory/variant-stock";
import { orderService } from "@/modules/order/service";
import { listStatusHistory } from "@/modules/order/queries";
import { order_return_items } from "@/modules/order/returns.schema";
import { stockLocationService } from "@/modules/stock-location";
import type { StockLocationRow } from "@/modules/stock-location/schema";
import { bus } from "../bus";

/**
 * Keep the selling DEPOT's physical `stock_levels` in sync with order fulfilment
 * in per_location + `central` web-stock mode (no-op for a single-pool / combined
 * store). The cached TOTAL moves at PLACEMENT (down) and on RESTOCK (up); the
 * depot LEVEL moves when units physically cross the depot's dock — which these
 * handlers track so the matrix + the order-driven auto-request shortfall are
 * exact. A shared-stock product's units live in its POOL level (variantId null),
 * so a shared line is redirected there (mirrors the placement decrement + the
 * matrix). Best-effort, post-commit.
 *
 * DECREMENT when goods LEAVE the depot (total already dropped at placement, so
 * the level drops alone). Three fulfilment exits, none double-counting:
 *  - order.shipment_created (a BL parcel): drop the depot by that parcel's exact lines.
 *  - order.status_changed → "shipped" (the one-click "Marquer expédiée", NO parcel):
 *    drop the depot by each line's UNSHIPPED REMAINDER (quantity − Σ shipments).
 *    shipments are committed before this fires, so the remainder never
 *    double-counts a parcel that already decremented its share.
 *  - order.status_changed → "delivered" on a PICKUP order that never shipped:
 *    collected at the counter, so the units left the depot without a ship step.
 *
 * CREDIT when goods COME BACK to the depot:
 *  - order.return.received: a received return restocks the sellable TOTAL
 *    (restock.ts) but writes a location-less `return` leg — so the depot level
 *    must be credited too, the exact mirror of the ship/pickup decrement.
 */
async function depotIfPerLocation(): Promise<StockLocationRow | null> {
  const cfg = resolveInventoryConfig(await getSettingsMap());
  // Only the `central` web-stock model ships from (and decrements) the Centrale
  // depot. In `combined` mode the locations are flat peers — the aggregate total
  // already dropped at placement and no single depot level is tracked at ship.
  if (cfg.locationMode !== "per_location" || cfg.webStockSource !== "central") return null;
  return (await stockLocationService.listAll()).find((l) => l.is_default && l.is_active) ?? null;
}

export function registerShipDepotDecrementSubscriber() {
  // Parcel path — exact per-line quantities in the shipment.
  bus.on("order.shipment_created", async ({ payload }) => {
    try {
      const depot = await depotIfPerLocation();
      if (!depot) return;
      const items = await orderService.listShipmentItemsWithLines(payload.shipmentId);
      const shared = await resolveSharedStockProductIds(items.map((it) => it.line.product_id));
      for (const it of items) {
        await stockLocationService.adjustLevelOnly(
          {
            productId: it.line.product_id,
            variantId: shared.has(it.line.product_id) ? null : (it.line.variant_id ?? null),
          },
          depot.id,
          -it.quantity,
          { reason: "order", orderId: payload.orderId, note: `Expédition BL ${payload.deliveryNoteNumber}` },
        );
      }
    } catch (err) {
      console.error("[ship-depot-decrement] parcel failed", err);
    }
  });

  // Status-only ship (no BL parcel) — decrement the UNSHIPPED remainder so the
  // depot still drops. A fully-parceled order lands here with remainder 0 (no-op).
  bus.on("order.status_changed", async ({ payload }) => {
    if (payload.toStatus !== "shipped") return;
    try {
      const depot = await depotIfPerLocation();
      if (!depot) return;
      const [items, shipped] = await Promise.all([
        orderService.listItems(payload.orderId),
        orderService.shippedQtyByItem(payload.orderId),
      ]);
      const shared = await resolveSharedStockProductIds(items.map((it) => it.product_id));
      for (const it of items) {
        const remainder = it.quantity - (shipped.get(it.id) ?? 0);
        if (remainder <= 0) continue;
        await stockLocationService.adjustLevelOnly(
          { productId: it.product_id, variantId: shared.has(it.product_id) ? null : (it.variant_id ?? null) },
          depot.id,
          -remainder,
          { reason: "order", orderId: payload.orderId, note: `Commande ${payload.orderNumber} expédiée` },
        );
      }
    } catch (err) {
      console.error("[ship-depot-decrement] status ship failed", err);
    }
  });

  // PICKUP fulfillment path — a pickup order (in-store / drive-by) is COLLECTED, never
  // shipped (preparing → delivered directly), so NEITHER ship path above ever dropped
  // its depot level: the cached total fell at placement but the depot's stock_levels
  // stayed high forever (drift). Drop it on "delivered" — but ONLY when the order never
  // passed through "shipped" (an order that DID ship already dropped the depot there,
  // and a status-ship records no shipment rows for the remainder to shrink against, so
  // decrementing again would DOUBLE-count). ISSUE-31.
  bus.on("order.status_changed", async ({ payload }) => {
    if (payload.toStatus !== "delivered") return;
    try {
      const depot = await depotIfPerLocation();
      if (!depot) return;
      const history = await listStatusHistory(payload.orderId);
      if (history.some((h) => h.to_status === "shipped")) return; // already dropped at ship
      const [items, shipped] = await Promise.all([
        orderService.listItems(payload.orderId),
        orderService.shippedQtyByItem(payload.orderId),
      ]);
      const shared = await resolveSharedStockProductIds(items.map((it) => it.product_id));
      for (const it of items) {
        const remainder = it.quantity - (shipped.get(it.id) ?? 0);
        if (remainder <= 0) continue;
        await stockLocationService.adjustLevelOnly(
          { productId: it.product_id, variantId: shared.has(it.product_id) ? null : (it.variant_id ?? null) },
          depot.id,
          -remainder,
          { reason: "order", orderId: payload.orderId, note: `Commande ${payload.orderNumber} retirée` },
        );
      }
    } catch (err) {
      console.error("[ship-depot-decrement] delivered (pickup) failed", err);
    }
  });

  // RETURN credit — the mirror of the ship/pickup decrement. A received return
  // restocks the sellable TOTAL (restock.ts bumps stock_qty) but ledgers only a
  // location-less `return` leg; it never credits the depot's stock_levels. The
  // returned units physically came back to the Centrale, so in per_location +
  // central mode the depot level would otherwise sit UNDER the total forever
  // (the matrix shows fewer units at the Centrale than are actually sellable —
  // the mirror drift of an un-decremented ship). Credit the depot by each
  // RESTOCKED, restockable line (`restocked_at` set). adjustLevelOnly no-ops an
  // untracked target (stock_qty NULL). EDGE: restockReturnLines stamps
  // `restocked_at` even on a SOFT-DELETED tracked product whose total it skipped
  // (its UPDATE is gated on `deleted_at IS NULL`), so this would credit a level
  // whose total wasn't restored — harmless (a deleted product is unsellable and
  // absent from the matrix), but not a true "restocked_at ⇒ total moved". ISSUE-31 #3.
  bus.on("order.return.received", async ({ payload }) => {
    try {
      const depot = await depotIfPerLocation();
      if (!depot) return;
      const lines = await db
        .select({
          productId: order_return_items.product_id,
          variantId: order_return_items.variant_id,
          quantity: order_return_items.quantity,
        })
        .from(order_return_items)
        .where(
          and(
            eq(order_return_items.return_id, payload.returnId),
            eq(order_return_items.restockable, true),
            isNotNull(order_return_items.restocked_at),
          ),
        );
      if (lines.length === 0) return;
      const shared = await resolveSharedStockProductIds(lines.map((l) => l.productId));
      for (const l of lines) {
        if (l.quantity <= 0) continue;
        await stockLocationService.adjustLevelOnly(
          { productId: l.productId, variantId: shared.has(l.productId) ? null : (l.variantId ?? null) },
          depot.id,
          l.quantity,
          { reason: "return", orderId: payload.orderId, note: `Retour ${payload.returnId} réintégré` },
        );
      }
    } catch (err) {
      console.error("[ship-depot-decrement] return credit failed", err);
    }
  });
}
