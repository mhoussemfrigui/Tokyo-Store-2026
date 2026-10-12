import { NextResponse } from "next/server";

import { orderService } from "@/modules/order/service";
import { deliveredAtByOrder } from "@/modules/order/queries";
import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { serializeOrder, serializeOrderItem, resolveApiOrder } from "@/lib/api/orders";
import { computeOrderLineWarranty } from "@/lib/warranty";

/**
 * /api/orders/[id] — external order API, READ a single order WITH its lines.
 * The `[id]` segment accepts the uuid order id OR the ERP `externalRef`.
 * Scope: orders:read.
 *
 * Each line carries `warrantyMonths` / `warrantyLabel` (the checkout snapshot, from
 * serializeOrderItem) PLUS an order-AWARE `warranty` verdict (state / expiresAt /
 * display) — computed here because it needs the order's status + delivery date, so
 * an ERP/SAV integration knows whether a unit is still covered without re-deriving
 * the cascade.
 */
const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "orders.get");
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const order = await resolveApiOrder(id);
  if (!order) {
    return NextResponse.json({ error: "Commande introuvable." }, { status: 404, headers: noStore });
  }
  const items = await orderService.listItems(order.id);
  const deliveredAt = (await deliveredAtByOrder([order.id]).catch(() => new Map<string, Date>())).get(order.id) ?? null;
  const facts = { status: order.status, createdAt: order.created_at, paidAt: order.paid_at, deliveredAt };
  return NextResponse.json(
    {
      data: {
        ...serializeOrder(order),
        items: items.map((it) => {
          const w = computeOrderLineWarranty(facts, it.warranty_months, it.warranty_label);
          return {
            ...serializeOrderItem(it),
            warranty: {
              state: w.state,
              expiresAt: w.expiresAt ? w.expiresAt.toISOString() : null,
              display: w.display,
            },
          };
        }),
      },
    },
    { headers: noStore },
  );
}
