import "server-only";

import type { OrderItemRow, OrderRow } from "@/modules/order/schema";
import { orderService } from "@/modules/order/service";
import { orderTaxIncludedInTotal } from "@/lib/order/order-tax-mode";
import { isUuid } from "@/lib/utils/uuid";

/**
 * Serialisers + lookups for the keyed external order API (ERP sync). Exposes a
 * stable, camelCase JSON shape with the uuid `id`, the ERP `externalRef`, the
 * fiscal document numbers, and money in integer millimes — so an ERP can
 * round-trip + reconcile. No PII beyond the contact + shipping the order already
 * holds; no internal-only columns (audit) are leaked. Every term of the total is
 * exposed, so an ERP can check
 *   totalCents = subtotalCents + shippingCents + careCents − discountCents
 *                + (taxIncludedInTotal ? 0 : taxCents)
 * — `careCents` is the Tokyo Care protection add-on (ex-TVA; its TVA is inside
 * `taxCents`), a real additive term of the total like shipping.
 * — `taxIncludedInTotal` is the renderers' rule (TTC extract vs HT add-on, read
 * from the order's own arithmetic, never the live store mode). `userId` is the
 * customer's storefront ACCOUNT id (null = guest order) — the same key the
 * customers API (`ApiCustomer.userId`) carries, so a synced order joins its
 * customer without fuzzy email matching.
 */
export function serializeOrder(o: OrderRow) {
  return {
    id: o.id,
    externalRef: o.external_ref,
    userId: o.user_id,
    orderNumber: o.order_number,
    status: o.status,
    currency: o.currency,
    paymentMethod: o.payment_method,
    paymentReference: o.payment_reference,
    subtotalCents: o.subtotal_cents,
    shippingCents: o.shipping_cents,
    discountCents: o.discount_cents,
    // Tokyo Care protection add-on (ex-TVA; its TVA is inside taxCents) — a real
    // additive term of totalCents, exposed so an ERP can reconcile care orders.
    careCents: o.care_cents,
    taxCents: o.tax_manual_cents ?? o.tax_cents,
    taxIncludedInTotal: orderTaxIncludedInTotal(o),
    totalCents: o.total_cents,
    contactEmail: o.contact_email,
    contactPhone: o.contact_phone,
    shipping: {
      fullName: o.ship_full_name,
      streetLine1: o.ship_street_line1,
      streetLine2: o.ship_street_line2,
      city: o.ship_city,
      region: o.ship_region,
      postalCode: o.ship_postal_code,
      country: o.ship_country,
      phone: o.ship_phone,
    },
    deliveryMethod: o.delivery_method,
    deliveryAgentName: o.delivery_agent_name,
    pickupLocationName: o.pickup_location_name,
    // Sales channel / origin (migration 0172) — lets an ERP see where the order
    // came from (storefront / operator / express / erp).
    channel: o.channel,
    invoiceNumber: o.invoice_number,
    creditNoteNumber: o.credit_note_number,
    deliveryNoteNumber: o.delivery_note_number,
    createdAt: o.created_at.toISOString(),
    updatedAt: o.updated_at.toISOString(),
    paidAt: o.paid_at ? o.paid_at.toISOString() : null,
  };
}

export function serializeOrderItem(it: OrderItemRow) {
  return {
    id: it.id,
    productId: it.product_id,
    variantId: it.variant_id,
    name: it.product_name,
    sku: it.variant_sku ?? it.product_sku,
    quantity: it.quantity,
    unitPriceCents: it.unit_price_cents,
    subtotalCents: it.subtotal_cents,
    taxCents: it.tax_cents,
    // Warranty DURATION snapshot frozen at checkout (product→category→global
    // cascade). The order-AWARE verdict (state/expiresAt) is added by the single
    // order GET, which has the order facts; the pure duration ships everywhere.
    warrantyMonths: it.warranty_months,
    warrantyLabel: it.warranty_label,
  };
}

/**
 * Resolve an order from a path param that may be a uuid id OR an externalRef. A
 * uuid-shaped param that is not a local id FALLS BACK to the externalRef lookup
 * (one extra indexed query) — an ERP keying its own orders by UUID must still
 * reach `/api/orders/{its ref}[/…]`.
 */
export async function resolveApiOrder(idOrRef: string): Promise<OrderRow | null> {
  if (isUuid(idOrRef)) {
    const byId = await orderService.findById(idOrRef);
    if (byId) return byId;
  }
  return orderService.findByExternalRef(idOrRef);
}
