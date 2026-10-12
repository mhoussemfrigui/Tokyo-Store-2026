import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { resolveInventoryConfig } from "@/lib/inventory/locations-config";
import { normalizePlanLines, planAutoTransfers, type PlanItem, type SourceLoc } from "@/lib/inventory/auto-transfer-plan";
import { resolveSharedStockProductIds } from "@/lib/inventory/variant-stock";
import { orderService } from "@/modules/order/service";
import { stockLocationService } from "@/modules/stock-location";
import { stockTransferService } from "@/modules/stock-transfer";

/**
 * Order-driven auto-replenishment: when an online order lands and the depot can't
 * fill it, request store→depot transfer(s) so the operator can move the goods in
 * and ship. Gated on per_location mode + transfers enabled + the auto-request
 * setting. Best-effort (called from an `order.created` subscriber, post-commit) —
 * never throws into the order path. Returns how many transfers were created.
 *
 * Shortfall is read against the depot's CURRENT physical level, which only drops
 * at SHIP (ship-depot-decrement) — not at placement. So two orders landing before
 * either ships both see the same depot level and can jointly under-request when
 * the depot holds a few units (each assumes it can cover). This is deliberate: the
 * requests are operator-validated and completion re-checks source availability
 * (moveStockTx), the depot is designed to run near-empty (shortfall ≈ full qty,
 * where the double-count doesn't bite), and the transfers list surfaces the state
 * for reconciliation. We optimise for the empty-depot norm, not the rare overlap.
 */
export async function autoRequestTransfersForOrder(input: {
  orderId: string;
  orderNumber?: string;
  actorUserId?: string | null;
}): Promise<{ created: number }> {
  const cfg = resolveInventoryConfig(await getSettingsMap());
  // Auto store→Centrale replenishment only applies to the `central` web model (the
  // Centrale is the online depot). In `combined` mode there is no depot to top up.
  if (
    cfg.locationMode !== "per_location" ||
    cfg.webStockSource !== "central" ||
    !cfg.transfersEnabled ||
    !cfg.transferAutoRequest
  ) {
    return { created: 0 };
  }

  const locations = await stockLocationService.listAll();
  const depot = locations.find((l) => l.is_default && l.is_active);
  if (!depot) return { created: 0 };
  const sources: SourceLoc[] = locations
    .filter((l) => l.is_active && l.id !== depot.id)
    .map((l) => ({ id: l.id, displayOrder: l.display_order }));
  if (sources.length === 0) return { created: 0 };

  const items = await orderService.listItems(input.orderId);
  if (items.length === 0) return { created: 0 };

  // A shared-stock product tracks physical stock in its POOL level (variantId
  // null); normalizePlanLines redirects those lines there + merges by key so the
  // plan reads the real pool level (not a phantom per-variant 0) exactly once.
  const sharedProducts = await resolveSharedStockProductIds(items.map((it) => it.product_id));
  const planItems: PlanItem[] = normalizePlanLines(
    items.map((it) => ({ productId: it.product_id, variantId: it.variant_id ?? null, quantity: it.quantity })),
    sharedProducts,
  );
  if (planItems.length === 0) return { created: 0 };

  const levels = await stockLocationService.listLevelsForProducts([
    ...new Set(planItems.map((i) => i.productId)),
  ]);

  const plans = planAutoTransfers({
    items: planItems,
    depotId: depot.id,
    sources,
    levels,
    sourcing: cfg.transferSourcing,
  });

  let created = 0;
  for (const plan of plans) {
    try {
      await stockTransferService.create({
        fromLocationId: plan.fromLocationId,
        toLocationId: depot.id,
        items: plan.items,
        source: "auto",
        orderId: input.orderId,
        note: input.orderNumber ? `Réappro auto — commande ${input.orderNumber}` : "Réappro auto (commande)",
        requestedBy: input.actorUserId ?? "system",
      });
      created++;
    } catch (err) {
      console.error("[auto-transfer] transfer create failed", err);
    }
  }

  // Race guard: this runs post-commit of order.created, so an order cancelled in
  // the meantime already ran the cancel cascade — which found NO transfers to
  // cancel (ours didn't exist yet), leaving what we just created orphaned. Re-read
  // the order; if it's now cancelled, cancel our just-created transfers. Idempotent
  // (cancelPendingForOrder skips terminal ones) + best-effort.
  if (created > 0) {
    const order = await orderService.findById(input.orderId).catch(() => null);
    if (order?.status === "cancelled") {
      await stockTransferService
        .cancelPendingForOrder(input.orderId, { reason: "Commande annulée (course avec le réappro auto)" })
        .catch((err) => console.error("[auto-transfer] post-create cancel guard failed", err));
    }
  }
  return { created };
}
