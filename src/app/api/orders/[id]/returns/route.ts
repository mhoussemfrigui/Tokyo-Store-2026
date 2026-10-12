import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { requireApiActor } from "@/lib/api-auth/actor";
import { readJsonObject, workflowResponse } from "@/lib/api-auth/respond";
import { workflows } from "@/workflows";
import { resolveApiOrder } from "@/lib/api/orders";
import { listApiReturns } from "@/lib/api/order-substreams";
import { UUID_RE } from "@/lib/api/cursor";

/**
 * /api/orders/[id]/returns — order returns (RMA). `[id]` = uuid or externalRef.
 *
 *   GET    list returns WITH their line items (orders:read).
 *   POST   open a return { items:[{orderItemId,quantity,conditionNote?}],
 *          reasonCode?, reason?, comment? } (orders:write). `lines` is accepted
 *          as an alias of `items` (the workflow's own field name).
 *   PATCH  advance a return { returnId, action:"receive"|"reject" } (orders:write) —
 *          `receive` restocks the returned units + ledgers them; `reject` closes it.
 *          The return must belong to the order in the path (404 otherwise).
 */
const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "orders.returns");
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const order = await resolveApiOrder(id);
  if (!order) {
    return NextResponse.json({ error: "Commande introuvable." }, { status: 404, headers: noStore });
  }
  return NextResponse.json({ returns: await listApiReturns(order.id) }, { headers: noStore });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "orders.create_return");
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

  // The documented body field is `items` (API.md / route catalog) while the
  // workflow schema names it `lines` — accept either so a client following the
  // docs isn't refused with a bare "Validation échouée".
  const { items, ...rest } = parsed.body;
  const result = await workflows.order.createReturn(
    { ...rest, lines: rest.lines ?? items, orderId: order.id } as never,
    { actorUserId: actor.actorUserId },
  );
  return workflowResponse(result, 201);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "orders.update_return");
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

  const returnId = typeof parsed.body.returnId === "string" ? parsed.body.returnId.trim() : "";
  const action = parsed.body.action;
  if (!returnId || (action !== "receive" && action !== "reject")) {
    return NextResponse.json(
      { error: "Fournir { returnId, action: 'receive' | 'reject' }." },
      { status: 400, headers: noStore },
    );
  }
  if (!UUID_RE.test(returnId)) {
    return NextResponse.json({ error: "returnId invalide (UUID attendu)." }, { status: 400, headers: noStore });
  }
  // Scoped to the path's order: a returnId of ANOTHER order reads as 404
  // (never acts on that other order's return while reporting success here).
  const result =
    action === "receive"
      ? await workflows.order.receiveReturn({ returnId, orderId: order.id }, { actorUserId: actor.actorUserId })
      : await workflows.order.rejectReturn({ returnId, orderId: order.id }, { actorUserId: actor.actorUserId });
  return workflowResponse(result);
}
