import "server-only";

import { dispatchEmail, isFlowEnabled, mailingSendsService } from "@/modules/mailing";
import { orderService } from "@/modules/order/service";
import { firstNameOf } from "@/lib/email/util";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { bus } from "../bus";

const FLOW_BY_STATUS: Record<
  string,
  "order_paid" | "order_preparing" | "order_shipped" | "order_delivered" | "order_cancelled"
> = {
  // `paid` is only ever reached by ONLINE orders (COD settles at delivery
  // without a `paid` status), so this fires the payment-received mail for online
  // payments only — exactly as intended.
  paid: "order_paid",
  preparing: "order_preparing",
  shipped: "order_shipped",
  delivered: "order_delivered",
  cancelled: "order_cancelled",
};

/**
 * Order shipped / delivered / cancelled notifications on `order.status_changed`.
 * Transactional (commerce) — no marketing consent gate; only the flow toggle
 * gates it. Idempotent per (order, status) so a status bounce can't double-send.
 */
export function registerOrderStatusEmailSubscriber() {
  bus.on("order.status_changed", async ({ payload }) => {
    try {
      const flow = FLOW_BY_STATUS[payload.toStatus];
      if (!flow) return;
      if (!(await isFlowEnabled(flow))) return;

      const order = await orderService.findById(payload.orderId);
      if (!order || !order.contact_email) return;

      const first = await mailingSendsService
        .claimOnce(flow, `${payload.orderId}:${payload.toStatus}`)
        .catch(() => false);
      if (!first) return;

      await dispatchEmail({
        key: flow,
        to: order.contact_email,
        flowKey: flow,
        variables: {
          // First name, like the receipt — every commerce mail greets the same way.
          customer_name: firstNameOf(order.ship_full_name),
          order_number: order.order_number,
          order_url: `${await resolvePublicOrigin()}/order/${order.id}`,
        },
      });
    } catch (err) {
      console.error("[events] send-order-status failed", err);
    }
  });
}
