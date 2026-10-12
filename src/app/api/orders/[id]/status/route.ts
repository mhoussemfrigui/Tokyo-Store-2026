import { NextResponse } from "next/server";

import { workflows } from "@/workflows";
import { checkOrderExternalRefChange, type OrderExternalRefInput } from "@/workflows/order/set-external-ref";
import { orderService } from "@/modules/order/service";
import { enforceExternalApi, workflowErrorStatus } from "@/lib/api-auth/enforce";
import { requireApiActor } from "@/lib/api-auth/actor";
import { readJsonObject, workflowResponse } from "@/lib/api-auth/respond";
import { serializeOrder, resolveApiOrder } from "@/lib/api/orders";

/**
 * /api/orders/[id]/status — external order API, WRITE: push a status change +
 * tracking from a WMS/3PL/ERP. Body: { status?, paymentReference?, notes?,
 * externalRef?, unlink? }. `[id]` is the uuid id OR the ERP externalRef.
 *
 * The status transition runs the SAME server state machine the dashboard uses
 * (payment-method-aware graph), so an ERP follows the same status rules as an
 * operator. `paymentReference` / `notes` are written ON that transition, so they
 * require `status` (400 without it — they used to be dropped behind a 200).
 *
 * `externalRef` links the order to its ERP record through the
 * `order.set_external_ref` workflow (idempotent; audited; a different ref on a
 * linked order → 409 already_linked; a ref owned by another order → 409
 * external_ref_conflict). Clearing the link needs `unlink: true` — a blank
 * `externalRef` is a 400. The link is PRE-CHECKED before the transition and
 * stamped after it (re-checked under the row lock), so a refused transition never
 * leaves a stamped link and a link the rules refuse never leaves a committed
 * transition — only a concurrent same-ref race can still 409 after it.
 * Scope: orders:write (key must have an owner).
 */
const noStore = { "Cache-Control": "no-store" } as const;

/** A non-blank string field (what the transition would actually write). */
function presentText(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "orders.update_status");
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

  const hasStatus = typeof body.status === "string";
  if (!hasStatus && (presentText(body.paymentReference) || presentText(body.notes))) {
    return NextResponse.json(
      {
        error: "paymentReference et notes accompagnent un changement de statut : ajoutez « status ».",
        code: "validation",
        fieldErrors: { status: "Requis avec paymentReference / notes." },
      },
      { status: 400, headers: noStore },
    );
  }

  // ERP link request (`externalRef` and/or `unlink`; a JSON null = absent).
  const linkRequested =
    (body.externalRef !== undefined && body.externalRef !== null) ||
    (body.unlink !== undefined && body.unlink !== null);
  const link = { externalRef: body.externalRef ?? undefined, unlink: body.unlink ?? undefined } as OrderExternalRefInput;
  if (linkRequested) {
    const plan = await checkOrderExternalRefChange(order, link);
    if (plan.kind === "fail") return workflowResponse(plan.error);
  }

  // Transition the status when requested — the workflow validates the target +
  // the transition graph, and stamps the tracking reference.
  let statusApplied = false;
  if (hasStatus) {
    const result = await workflows.order.transitionStatus(
      {
        orderId: order.id,
        toStatus: body.status as never,
        paymentReference: typeof body.paymentReference === "string" ? body.paymentReference : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
      },
      { actorUserId: actor.actorUserId },
    );
    if (!result.ok) return workflowResponse(result);
    statusApplied = true;
  }

  // Stamp / clear the link (locked + re-validated + audited in the workflow).
  // The link is pre-checked above, so it fails here only on a concurrent same-ref
  // race — after the status transition already committed (separate txns). Surface
  // `statusApplied` + the fresh order so the ERP retries only the link (or
  // reconciles the ref conflict) instead of blindly re-sending the whole PATCH,
  // whose already-applied transition would then be refused.
  if (linkRequested) {
    const linked = await workflows.order.setExternalRef(
      { orderId: order.id, ...link },
      { actorUserId: actor.actorUserId },
    );
    if (!linked.ok) {
      if (!statusApplied) return workflowResponse(linked);
      const fresh = await orderService.findById(order.id);
      return NextResponse.json(
        {
          error: linked.message,
          code: linked.error,
          ...(linked.fieldErrors ? { fieldErrors: linked.fieldErrors } : {}),
          statusApplied: true,
          data: fresh ? serializeOrder(fresh) : null,
        },
        { status: workflowErrorStatus(linked.error), headers: noStore },
      );
    }
  }

  const fresh = await orderService.findById(order.id);
  return NextResponse.json({ data: fresh ? serializeOrder(fresh) : null }, { headers: noStore });
}
