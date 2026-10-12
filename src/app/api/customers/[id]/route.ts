import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { resolveApiCustomer, getApiCustomerFull } from "@/lib/api/customers";

/**
 * /api/customers/[id] — external customer API, READ one customer WITH addresses.
 * `[id]` accepts the uuid profile id OR the ERP externalRef.
 * KEY-ONLY (PII). Scope: customers:read.
 */
const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "customers.get");
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const profile = await resolveApiCustomer(id);
  if (!profile) {
    return NextResponse.json({ error: "Client introuvable." }, { status: 404, headers: noStore });
  }
  return NextResponse.json({ data: await getApiCustomerFull(profile) }, { headers: noStore });
}
