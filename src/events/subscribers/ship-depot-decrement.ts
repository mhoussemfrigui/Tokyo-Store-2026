import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { resolveInventoryConfig } from "@/lib/inventory/locations-config";
import { resolveSharedStockProductIds } from "@/lib/inventory/variant-stock";
import { orderService } from "@/modules/order/service";
import { stockLocationService } from "@/modules/stock-location";
import type { StockLocationRow } from "@/modules/stock-location/schema";
import { bus } from "../bus";

/**
 * Per-location physical decrement on SHIP. In per_location mode, when goods leave
 * the selling DEPOT for a customer, drop the depot's `stock_levels` by the shipped
 * quantities (LEVEL-ONLY — the cached TOTAL already dropped at order PLACEMENT, so
 * it is NOT touched again). This makes the depot level track physical reality so
 * the order-driven auto-request shortfall is exact. No-op for a single-pool store.
 * A shared-stock product's units live in its POOL level (variantId null), so a
 * shared line is redirected there (mirrors the placement decrement + the matrix).
 * Best-effort, post-commit.
 *
 * TWO ship paths, and a parcel + a later status-ship must not double-decrement:
 *  - order.shipment_created (a BL parcel): drop the depot by that parcel's exact lines.
 *  - order.status_changed → "shipped" (the one-click "Marquer expédiée", NO parcel):
 *    drop the depot by each line's UNSHIPPED REMAINDER (quantity − Σ shipments).
 *    shipments are committed before this fires, so the remainder never
 *    double-counts a parcel that already decremented its share.
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
}
