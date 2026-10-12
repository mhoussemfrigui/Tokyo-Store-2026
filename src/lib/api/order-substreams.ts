import "server-only";

import { orderService } from "@/modules/order/service";
import { returnService } from "@/modules/order/returns.service";
import { listStatusHistory } from "@/modules/order/queries";
import { serializeOrderItem } from "@/lib/api/orders";
import type {
  OrderRefundRow,
  OrderStatusHistoryRow,
  ShipmentRow,
} from "@/modules/order/schema";
import type { OrderReturnItemRow } from "@/modules/order/returns.schema";

/**
 * Serializers + readers for the order SUB-STREAMS an ERP mirrors: shipments
 * (parcels + tracking + BL number), refunds, and the status-change history.
 * Thin wrappers over the existing order service list methods. camelCase / millimes.
 */

export function serializeStatusChange(h: OrderStatusHistoryRow) {
  return {
    id: h.id,
    fromStatus: h.from_status,
    toStatus: h.to_status,
    notes: h.notes,
    createdAt: h.created_at.toISOString(),
  };
}

export function serializeRefund(r: OrderRefundRow) {
  return {
    id: r.id,
    amountCents: r.amount_cents,
    reason: r.reason,
    createdAt: r.created_at.toISOString(),
  };
}

function serializeShipmentBase(s: ShipmentRow) {
  return {
    id: s.id,
    deliveryNoteNumber: s.delivery_note_number,
    deliveryNoteAt: s.delivery_note_at ? s.delivery_note_at.toISOString() : null,
    deliveryMethod: s.delivery_method,
    deliveryAgentName: s.delivery_agent_name,
    trackingRef: s.tracking_ref,
    shippedAt: s.shipped_at ? s.shipped_at.toISOString() : null,
    notes: s.notes,
    createdAt: s.created_at.toISOString(),
  };
}

/** Shipments for an order WITH their per-line parcel quantities. */
export async function listApiShipments(orderId: string) {
  const shipments = await orderService.listShipments(orderId);
  return Promise.all(
    shipments.map(async (s) => {
      const items = await orderService.listShipmentItemsWithLines(s.id);
      return {
        ...serializeShipmentBase(s),
        // `shippedQuantity` = units in THIS parcel; the spread line keeps the
        // order item's own `quantity` (the total ordered) — distinct numbers.
        items: items.map((it) => ({ ...serializeOrderItem(it.line), shippedQuantity: it.quantity })),
      };
    }),
  );
}

export async function listApiRefunds(orderId: string) {
  const rows = await orderService.listRefunds(orderId);
  return rows.map(serializeRefund);
}

export async function listApiStatusHistory(orderId: string) {
  const rows = await listStatusHistory(orderId);
  return rows.map(serializeStatusChange);
}

function serializeReturnItem(i: OrderReturnItemRow) {
  return {
    id: i.id,
    orderItemId: i.order_item_id,
    productId: i.product_id,
    variantId: i.variant_id,
    quantity: i.quantity,
    conditionNote: i.condition_note,
  };
}

/** Returns (RMA) for an order WITH their line items. */
export async function listApiReturns(orderId: string) {
  const returns = await returnService.listForOrder(orderId);
  return Promise.all(
    returns.map(async (r) => {
      const items = await returnService.listItems(r.id);
      return {
        id: r.id,
        status: r.status,
        reasonCode: r.reason_code,
        reason: r.reason,
        createdAt: r.created_at.toISOString(),
        items: items.map(serializeReturnItem),
      };
    }),
  );
}
