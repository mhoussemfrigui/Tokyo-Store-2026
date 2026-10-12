import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { requireApiActor } from "@/lib/api-auth/actor";
import { readJsonObject, workflowResponse } from "@/lib/api-auth/respond";
import { workflows } from "@/workflows";
import { customerService } from "@/modules/customer/service";
import { parseIncrementalCursor } from "@/lib/api/cursor";
import {
  listApiCustomers,
  findApiCustomerByEmail,
  serializeOneCustomer,
  resolveApiCustomer,
} from "@/lib/api/customers";

/**
 * /api/customers — external customer API (ERP sync), READ.
 *
 *   GET  incremental sync: ?since= (ISO) + ?sinceId= (uuid) composite cursor,
 *        ?limit (1–200, default 50). Ordered updated_at ASC, id ASC; page forward
 *        with pagination.{nextSince,nextId}. OR look one up by reference:
 *        ?externalRef= / ?email= / ?phone= (caller picks the field).
 *
 * KEY-ONLY (canBePublic:false) — the payload is customer PII. Scope: customers:read.
 */
const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request) {
  const gate = await enforceExternalApi(request, "customers.list");
  if (!gate.ok) return gate.response;

  const { searchParams } = new URL(request.url);

  // Single-customer lookup by reference (ERP reconcile / initial match).
  const externalRef = searchParams.get("externalRef")?.trim();
  const email = searchParams.get("email")?.trim();
  const phone = searchParams.get("phone")?.trim();
  if (externalRef || email || phone) {
    const profile = externalRef
      ? await customerService.findByExternalRef(externalRef)
      : email
        ? await findApiCustomerByEmail(email)
        : await customerService.findByPhone(phone!);
    return NextResponse.json(
      { customers: profile ? [await serializeOneCustomer(profile)] : [] },
      { headers: noStore },
    );
  }

  const cur = parseIncrementalCursor(searchParams);
  if (!cur.ok) return NextResponse.json({ error: cur.error }, { status: 400, headers: noStore });

  const { customers, nextSince, nextId } = await listApiCustomers({
    sinceIso: cur.sinceIso,
    sinceId: cur.sinceId,
    limit: cur.limit,
  });
  return NextResponse.json(
    { customers, pagination: { limit: cur.limit, count: customers.length, nextSince, nextId } },
    { headers: noStore },
  );
}

/** Shared write path. `routeId` picks the scope-lookup (all are customers:write). */
async function writeCustomer(request: Request, routeId: string, mustExist: boolean, successStatus: number) {
  const gate = await enforceExternalApi(request, routeId);
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  const result = await workflows.customer.upsertFromApi(parsed.body as never, {
    actorUserId: actor.actorUserId,
    mustExist,
  });
  if (!result.ok) return workflowResponse(result);

  const profile = await resolveApiCustomer(result.data.customerId);
  return NextResponse.json(
    { data: profile ? await serializeOneCustomer(profile) : result.data },
    { status: result.data.created ? 201 : successStatus, headers: noStore },
  );
}

/** POST — create a customer profile ({ firstName, lastName, externalRef?, … }). */
export async function POST(request: Request) {
  return writeCustomer(request, "customers.create", false, 201);
}

/** PUT — upsert by externalRef (create if absent, else update). */
export async function PUT(request: Request) {
  return writeCustomer(request, "customers.upsert", false, 200);
}

/** PATCH — update an existing customer (by id or externalRef). */
export async function PATCH(request: Request) {
  return writeCustomer(request, "customers.update", true, 200);
}
