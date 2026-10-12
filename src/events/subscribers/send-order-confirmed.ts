import "server-only";

import { dispatchEmail, isFlowEnabled, mailingSendsService } from "@/modules/mailing";
import { orderService } from "@/modules/order/service";
import { firstNameOf } from "@/lib/email/util";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { bus } from "../bus";

/**
 * "Commande confirmée" notification on `order.confirmed` — an operator accepted
 * a COD order (online orders auto-confirm on payment, which already fires the
 * order_paid mail, so this is mainly the COD acceptance touchpoint).
 * Transactional (commerce): only the flow toggle gates it. Idempotent per order
 * so a re-confirm can't double-send.
 */
export function registerOrderConfirmedEmailSubscriber() {
  bus.on("order.confirmed", async ({ payload }) => {
    try {
      if (!(await isFlowEnabled("order_confirmed"))) return;

      const order = await orderService.findById(payload.orderId);
      if (!order || !order.contact_email) return;

      const first = await mailingSendsService
        .claimOnce("order_confirmed", payload.orderId)
        .catch(() => false);
      if (!first) return;

      await dispatchEmail({
        key: "order_confirmed",
        to: order.contact_email,
        flowKey: "order_confirmed",
        variables: {
          // First name, like the receipt — every commerce mail greets the same way.
          customer_name: firstNameOf(order.ship_full_name),
          order_number: order.order_number,
          order_url: `${await resolvePublicOrigin()}/order/${order.id}`,
        },
      });
    } catch (err) {
      console.error("[events] send-order-confirmed failed", err);
    }
  });
}
