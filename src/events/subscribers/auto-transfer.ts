import "server-only";

import { autoRequestTransfersForOrder } from "@/lib/inventory/auto-transfer";
import { stockTransferService } from "@/modules/stock-transfer";
import { bus } from "../bus";

/**
 * Auto-replenishment subscriber for `order.created`. When per-location mode +
 * transfers + auto-request are on and the selling depot can't fill the order, it
 * creates store→depot transfer request(s) linked to the order (source "auto").
 *
 * DETACHED (`void … .catch`): `bus.emit("order.created")` is awaited inside the
 * place-order workflow, so awaiting here would block the shopper's checkout
 * response on transfer planning + up to 20 ops-notification emails (the
 * stock.transfer.requested → notify-transfer chain runs inside this). The order
 * has already committed and the work is fully try/catch-wrapped + best-effort, so
 * the detached rejection is contained (mirrors detourage-main-image /
 * reembed-product, which detach their equally-heavy work). A no-op for a
 * single-pool store (all gating lives in autoRequestTransfersForOrder).
 */
export function registerAutoTransferSubscriber() {
  bus.on("order.created", ({ payload }) => {
    void autoRequestTransfersForOrder({
      orderId: payload.orderId,
      orderNumber: payload.orderNumber,
    }).catch((err) => console.error("[events] auto-transfer failed", err));
  });
}

/**
 * When an order is CANCELLED, cancel its non-terminal linked transfers (the
 * store→depot replenishment is no longer needed). A completed transfer is left
 * as-is (the goods already moved). Best-effort, post-commit.
 */
export function registerOrderCancelTransferSubscriber() {
  bus.on("order.status_changed", async ({ payload }) => {
    if (payload.toStatus !== "cancelled") return;
    try {
      await stockTransferService.cancelPendingForOrder(payload.orderId, {
        reason: `Commande ${payload.orderNumber} annulée`,
      });
    } catch (err) {
      console.error("[events] cancel-transfers-on-order-cancel failed", err);
    }
  });
}
