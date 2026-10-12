import "server-only";

import { ensureOrderDeliveryNoteNumber } from "@/lib/order/issue-delivery-note";
import { bus } from "../bus";

/**
 * Auto-issue the whole-order bon de livraison number the moment an order ships,
 * so every shipped order carries a BL ID without the operator having to stamp it
 * by hand on the Documents panel. Idempotent — an order that already has a
 * whole-order BL number (issued manually) is left untouched. SKIPPED when the
 * order was fulfilled through parcels (Shipments panel / ERP shipments API):
 * each parcel already drew its own BL number (`shipments.delivery_note_number`,
 * never copied onto the order), so a whole-order BL would number the same goods
 * twice. Best-effort: a failure never blocks the status change (which has
 * already committed before this async subscriber runs).
 */
export function registerIssueBlOnShipSubscriber() {
  bus.on("order.status_changed", async ({ payload }) => {
    if (payload.toStatus !== "shipped") return;
    try {
      const res = await ensureOrderDeliveryNoteNumber(payload.orderId, undefined, { skipIfShipments: true });
      if (res?.issued) {
        await bus.emit("order.delivery_note_issued", {
          orderId: payload.orderId,
          orderNumber: res.orderNumber,
          deliveryNoteNumber: res.number,
        });
      }
    } catch (err) {
      console.error("[events] issue-bl-on-ship failed", err);
    }
  });
}
