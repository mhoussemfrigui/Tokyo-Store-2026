import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { requireApiActor } from "@/lib/api-auth/actor";
import { readJsonObject, workflowResponse } from "@/lib/api-auth/respond";
import { workflows } from "@/workflows";
import { resolveApiOrder } from "@/lib/api/orders";
import { listApiRefunds } from "@/lib/api/order-substreams";

/**
 * /api/orders/[id]/refunds — order refunds. `[id]` = uuid or externalRef.
 *
 *   GET   the refund ledger (amount millimes + reason) — orders:read.
 *   POST  record a refund { amountCents, reason? } — orders:write. Runs the SAME
 *         refund workflow (validates against the remaining refundable amount,
 *         reverses loyalty/promos, restocks an unshipped order).
 */
const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "orders.refunds");
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const order = await resolveApiOrder(id);
  if (!order) {
    return NextResponse.json({ error: "Commande introuvable." }, { status: 404, headers: noStore });
  }
  return NextResponse.json({ refunds: await listApiRefunds(order.id) }, { headers: noStore });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "orders.create_refund");
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

  const result = await workflows.order.refund(
    { ...parsed.body, orderId: order.id } as never,
    { actorUserId: actor.actorUserId },
  );
  return workflowResponse(result, 201);
}
