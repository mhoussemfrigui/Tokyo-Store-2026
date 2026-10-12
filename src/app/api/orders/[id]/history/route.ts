import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { resolveApiOrder } from "@/lib/api/orders";
import { listApiStatusHistory } from "@/lib/api/order-substreams";

/**
 * /api/orders/[id]/history — the order's status-change history (append-only
 * from/to transitions). `[id]` = uuid or externalRef. Scope: orders:read.
 */
const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "orders.history");
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const order = await resolveApiOrder(id);
  if (!order) {
    return NextResponse.json({ error: "Commande introuvable." }, { status: 404, headers: noStore });
  }
  return NextResponse.json({ history: await listApiStatusHistory(order.id) }, { headers: noStore });
}
