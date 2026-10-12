import { NextResponse } from "next/server";

import { orderService } from "@/modules/order/service";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/order/status";
import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { requireApiActor } from "@/lib/api-auth/actor";
import { readJsonObject, workflowResponse } from "@/lib/api-auth/respond";
import { workflows } from "@/workflows";
import { serializeOrder } from "@/lib/api/orders";
import { parseIncrementalCursor } from "@/lib/api/cursor";

/**
 * /api/orders — external order API (ERP-friendly), READ.
 *
 *   GET  list orders for incremental sync: ?status= (one of the order statuses),
 *        ?since= (ISO timestamp) + ?sinceId= (uuid) — the forward cursor, ?limit
 *        (1–200, default 50). OR look one order up by ?externalRef= / ?orderNumber=.
 *
 * Ordered updated_at ASC, id ASC; the response carries a COMPOSITE cursor
 * `pagination.{nextSince,nextId}` (the last row's updatedAt + id). The caller
 * pages forward by passing BOTH back as `?since=&sinceId=` until the page returns
 * fewer than `limit` rows. The composite keyset means the boundary row is never
 * re-fetched and progress is guaranteed even when many orders share one
 * updated_at. (Passing only `?since=` still works — inclusive watermark, legacy.)
 * Scope: orders:read.
 */
const noStore = { "Cache-Control": "no-store" } as const;

function parseStatus(raw: string | null): { ok: true; value?: OrderStatus } | { ok: false } {
  if (!raw) return { ok: true };
  return ORDER_STATUSES.includes(raw as OrderStatus) ? { ok: true, value: raw as OrderStatus } : { ok: false };
}

export async function GET(request: Request) {
  const gate = await enforceExternalApi(request, "orders.list");
  if (!gate.ok) return gate.response;

  const { searchParams } = new URL(request.url);

  // Single-order lookup by reference (ERP reconcile).
  const externalRef = searchParams.get("externalRef")?.trim();
  const orderNumber = searchParams.get("orderNumber")?.trim();
  if (externalRef || orderNumber) {
    const order = externalRef
      ? await orderService.findByExternalRef(externalRef)
      : await orderService.findByOrderNumber(orderNumber!);
    return NextResponse.json(
      { orders: order ? [serializeOrder(order)] : [] },
      { headers: noStore },
    );
  }

  const status = parseStatus(searchParams.get("status"));
  if (!status.ok) {
    return NextResponse.json(
      { error: `status invalide. Valeurs : ${ORDER_STATUSES.join(", ")}.` },
      { status: 400, headers: noStore },
    );
  }
  // Shared incremental-sync cursor: the two-gate ISO validation (→ clean 400, never
  // a ::timestamptz 22008 → 500), the forgiving sinceId tiebreak, and the limit
  // clamp all live in one helper reused by every keyset-paginated read endpoint.
  const cursor = parseIncrementalCursor(searchParams);
  if (!cursor.ok) {
    return NextResponse.json({ error: cursor.error }, { status: 400, headers: noStore });
  }
  const { limit } = cursor;

  const { items, nextSince, nextId } = await orderService.listForApi({
    status: status.value,
    sinceIso: cursor.sinceIso,
    sinceId: cursor.sinceId,
    limit,
  });

  return NextResponse.json(
    { orders: items.map(serializeOrder), pagination: { limit, count: items.length, nextSince, nextId } },
    { headers: noStore },
  );
}

/**
 * POST /api/orders — ERP / POS ORDER PUSH. Body: a line array by product
 * reference + customer/shipping/delivery + offline settlement channel — see
 * `createOrderFromLinesWorkflow`. Live-prices the lines, runs the same
 * placeOrderWorkflow a web checkout does (atomic stock/tax/promo/loyalty),
 * settles cash/bank_transfer, stamps `externalRef`. Scope: orders:write.
 */
export async function POST(request: Request) {
  const gate = await enforceExternalApi(request, "orders.create");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  const result = await workflows.order.createFromLines(parsed.body as never, {
    actorUserId: actor.actorUserId,
  });
  if (!result.ok) return workflowResponse(result);

  const fresh = await orderService.findById(result.data.orderId);
  return NextResponse.json(
    { data: fresh ? serializeOrder(fresh) : result.data },
    { status: 201, headers: noStore },
  );
}
