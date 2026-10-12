import "server-only";

import type { StockMovementRow } from "@/modules/stock-movement/schema";

/**
 * Serializer for the stock "movement" ledger exposed to the ERP. The ledger is
 * append-only, so `createdAt` is the change axis + sync cursor. camelCase, ISO
 * timestamps; no internal-only columns.
 */

export function serializeStockMovement(m: StockMovementRow) {
  return {
    id: m.id,
    productId: m.product_id,
    variantId: m.variant_id,
    delta: m.delta, // signed: negative = removed/sold, positive = added/restocked
    resultingQty: m.resulting_qty, // on-hand AFTER the change (null = untracked)
    reason: m.reason, // order | cancellation | refund | return | api_delta | api_set | admin | transfer
    orderId: m.order_id,
    locationId: m.location_id,
    note: m.note,
    createdAt: m.created_at.toISOString(),
  };
}
