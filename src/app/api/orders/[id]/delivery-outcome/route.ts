import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { requireApiActor } from "@/lib/api-auth/actor";
import { readJsonObject, workflowResponse } from "@/lib/api-auth/respond";
import { workflows } from "@/workflows";
import { resolveApiOrder } from "@/lib/api/orders";
import { orderService } from "@/modules/order/service";
import { listItemsForOrder } from "@/modules/order/queries";

/**
 * /api/orders/[id]/delivery-outcome — the INBOUND external-livraison hook.
 * `[id]` = uuid or externalRef.
 *
 * An external carrier / 3PL reports that a SHIPPED parcel did NOT reach the
 * customer (unreachable, wrong address, refused, lost). We open a pending
 * « Retour d'expédition » (RTO) over the shipped lines — the SAME record an
 * operator creates by hand. The parcel physically returning (or being written
 * off) is confirmed later by RECEIVING that return (PATCH /returns
 * {action:'receive'}), which restocks + cancels the order. This endpoint never
 * mutates stock or the order status itself.
 *
 *   POST  { reason?: <shipment reason code>, reasonText?, carrier?|carrierName?,
 *           trackingRef?, attempts?|deliveryAttempts?, restockable?,
 *           lines?:[{orderItemId,quantity,restockable?,conditionNote?}] }
 *         (orders:write). `lines` is optional — omitted, every shipped line (or,
 *         for an order shipped without a bon de livraison, every ordered line)
 *         is included at its full quantity. `restockable` (default true) sets
 *         whether the returned goods go back to sellable stock on receipt — pass
 *         false for a parcel reported LOST in transit.
 */
const noStore = { "Cache-Control": "no-store" } as const;

type OutcomeLine = { orderItemId: string; quantity: number; restockable?: boolean; conditionNote?: string };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "orders.delivery_outcome");
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
  const body = parsed.body;

  // `restockable` must be a strict boolean when present — a non-boolean (e.g. the
  // string "false") would otherwise coerce to the restock=true default and
  // silently add physically-lost goods back to stock. Default true (the common
  // bounce-back case); pass false only for a parcel written off as lost.
  if (body.restockable !== undefined && typeof body.restockable !== "boolean") {
    return NextResponse.json(
      { error: "`restockable` doit être un booléen." },
      { status: 400, headers: noStore },
    );
  }
  const restockableDefault = body.restockable !== false; // default true; false ⇒ lost/written-off
  // Carrier-friendly aliases for the workflow's field names.
  const carrierName =
    typeof body.carrierName === "string"
      ? body.carrierName
      : typeof body.carrier === "string"
        ? body.carrier
        : undefined;
  const deliveryAttempts =
    typeof body.deliveryAttempts === "number"
      ? body.deliveryAttempts
      : typeof body.attempts === "number"
        ? body.attempts
        : undefined;

  // Resolve the lines to return: an explicit body.lines wins; otherwise every
  // shipped line (shipment_items) or, absent any bon de livraison, every ordered
  // line — all at full quantity. The createReturn workflow re-validates + caps
  // each line against the shipped/ordered ceiling under an order lock.
  let lines: OutcomeLine[];
  if (Array.isArray(body.lines) && body.lines.length > 0) {
    // Each element must be a real object — a null/primitive would crash the
    // restockable-default map below; the workflow then re-validates the fields.
    if (body.lines.some((l) => typeof l !== "object" || l === null)) {
      return NextResponse.json(
        { error: "`lines` doit être un tableau d'objets { orderItemId, quantity }." },
        { status: 400, headers: noStore },
      );
    }
    lines = body.lines as OutcomeLine[];
  } else {
    const shipped = await orderService.shippedQtyByItem(order.id);
    if (shipped.size > 0) {
      lines = [...shipped.entries()]
        .filter(([, qty]) => qty > 0)
        .map(([orderItemId, quantity]) => ({ orderItemId, quantity, restockable: restockableDefault }));
    } else {
      const items = await listItemsForOrder(order.id);
      lines = items.map((it) => ({ orderItemId: it.id, quantity: it.quantity, restockable: restockableDefault }));
    }
  }
  if (lines.length === 0) {
    return NextResponse.json(
      { error: "Aucune ligne expédiée à retourner pour cette commande." },
      { status: 400, headers: noStore },
    );
  }
  // A body line that omits `restockable` inherits the request-level default.
  lines = lines.map((l) => ({ ...l, restockable: l.restockable ?? restockableDefault }));

  const result = await workflows.order.createReturn(
    {
      orderId: order.id,
      kind: "shipment",
      reasonCode: typeof body.reason === "string" ? body.reason : undefined,
      reason: typeof body.reasonText === "string" ? body.reasonText : undefined,
      carrierName,
      trackingRef: typeof body.trackingRef === "string" ? body.trackingRef : undefined,
      deliveryAttempts,
      lines,
    } as never,
    { actorUserId: actor.actorUserId },
  );
  return workflowResponse(result, 201);
}
