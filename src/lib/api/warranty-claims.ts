import "server-only";

import { orderService } from "@/modules/order/service";
import { warrantyClaimService, type WarrantyClaimStatus } from "@/modules/warranty-claim";
import type { WarrantyClaimRow } from "@/modules/warranty-claim/schema";
import { isUuid } from "@/lib/utils/uuid";

/**
 * External (ERP) serialization for warranty claims (SAV / RMA). camelCase, dates
 * as ISO, millimes untouched — same conventions as serializeOrder.
 */
export function serializeWarrantyClaim(c: WarrantyClaimRow, orderNumber?: string | null) {
  return {
    id: c.id,
    orderId: c.order_id,
    orderNumber: orderNumber ?? null,
    orderItemId: c.order_item_id,
    productId: c.product_id,
    variantId: c.variant_id,
    productName: c.product_name,
    status: c.status,
    reasonCode: c.reason_code,
    reason: c.reason,
    comment: c.comment,
    resolution: c.resolution,
    resolutionNote: c.resolution_note,
    warrantyMonths: c.warranty_months,
    warrantyLabel: c.warranty_label,
    coveredUntil: c.covered_until ? c.covered_until.toISOString() : null,
    wasCovered: c.was_covered,
    externalRef: c.external_ref,
    processedAt: c.processed_at ? c.processed_at.toISOString() : null,
    createdAt: c.created_at.toISOString(),
    updatedAt: c.updated_at.toISOString(),
  };
}

/** Resolve a claim by its UUID or its external ERP reference. */
export async function resolveApiClaim(idOrRef: string): Promise<WarrantyClaimRow | null> {
  if (isUuid(idOrRef)) {
    const byId = await warrantyClaimService.findById(idOrRef);
    if (byId) return byId;
  }
  return warrantyClaimService.findByExternalRef(idOrRef);
}

/** The list serializer already carries the order number (joined in the service). */
export async function listApiClaims(opts: { status?: WarrantyClaimStatus; limit?: number }) {
  const rows = await warrantyClaimService.listAllWithOrder(opts);
  return rows.map((r) => ({
    id: r.id,
    orderId: r.orderId,
    orderNumber: r.orderNumber,
    orderItemId: r.orderItemId,
    productName: r.productName,
    status: r.status,
    reasonCode: r.reasonCode,
    resolution: r.resolution,
    wasCovered: r.wasCovered,
    externalRef: r.externalRef,
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Fetch a claim's order number for the single-claim serializer (best-effort). */
export async function orderNumberFor(orderId: string): Promise<string | null> {
  const order = await orderService.findById(orderId);
  return order?.order_number ?? null;
}
