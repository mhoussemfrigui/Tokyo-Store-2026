import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { requireApiActor } from "@/lib/api-auth/actor";
import { readJsonObject, workflowResponse } from "@/lib/api-auth/respond";
import { workflows } from "@/workflows";
import { resolveApiOrder } from "@/lib/api/orders";
import { listApiShipments } from "@/lib/api/order-substreams";

/**
 * /api/orders/[id]/shipments — order shipments (parcels). `[id]` = uuid or externalRef.
 *
 *   GET   list shipments WITH per-line shippedQuantity + tracking + BL number (orders:read).
 *   POST  create a partial-shipment parcel (orders:write) — a WMS/3PL pushes
 *         { lines:[{orderItemId,quantity}], deliveryMethod?, deliveryAgentName?,
 *           trackingRef?, notes?, markShipped? }. Runs the SAME create-shipment
 *         workflow the dashboard uses: order lock + shippable-status + over-ship
 *         guard + gapless BL number, and (markShipped) the "shipped" transition
 *         when every line is fully shipped.
 */
const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "orders.shipments");
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const order = await resolveApiOrder(id);
  if (!order) {
    return NextResponse.json({ error: "Commande introuvable." }, { status: 404, headers: noStore });
  }
  return NextResponse.json({ shipments: await listApiShipments(order.id) }, { headers: noStore });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "orders.create_shipment");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const { id } = await params;
  const order = await resolveApiOrder(id);
  if (!order) {
    return NextResponse.json({ error: "Commande introuvable." }, { status: 404, headers: noStore });
  }
  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  // The path is authoritative for the order id (overrides any body orderId); the
  // workflow validates lines / quantities.
  const result = await workflows.order.createShipment(
    { ...parsed.body, orderId: order.id } as never,
    { actorUserId: actor.actorUserId },
  );
  return workflowResponse(result, 201);
}
