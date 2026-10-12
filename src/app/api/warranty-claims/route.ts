import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { requireApiActor } from "@/lib/api-auth/actor";
import { readJsonObject, workflowResponse } from "@/lib/api-auth/respond";
import { workflows } from "@/workflows";
import { WARRANTY_CLAIM_STATUSES, type WarrantyClaimStatus } from "@/modules/warranty-claim";
import {
  listApiClaims,
  resolveApiClaim,
  serializeWarrantyClaim,
  orderNumberFor,
} from "@/lib/api/warranty-claims";

/**
 * /api/warranty-claims — warranty claims (SAV / RMA) collection.
 *
 *   GET   list claims (?status=, ?limit) OR one claim by ?externalRef= (warranty:read).
 *   POST  open a claim { orderId, orderItemId, reasonCode?, reason?, comment?,
 *         externalRef? } (warranty:write) — coverage is snapshotted at creation.
 */
const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request) {
  const gate = await enforceExternalApi(request, "warranty_claims.list");
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const externalRef = url.searchParams.get("externalRef")?.trim();
  if (externalRef) {
    const claim = await resolveApiClaim(externalRef);
    if (!claim) {
      return NextResponse.json({ error: "Réclamation introuvable." }, { status: 404, headers: noStore });
    }
    return NextResponse.json(
      { claim: serializeWarrantyClaim(claim, await orderNumberFor(claim.order_id)) },
      { headers: noStore },
    );
  }

  const rawStatus = url.searchParams.get("status")?.trim();
  if (rawStatus && !(WARRANTY_CLAIM_STATUSES as readonly string[]).includes(rawStatus)) {
    return NextResponse.json({ error: "status invalide." }, { status: 400, headers: noStore });
  }
  const rawLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.trunc(rawLimit) : undefined;
  const claims = await listApiClaims({ status: rawStatus as WarrantyClaimStatus | undefined, limit });
  return NextResponse.json({ claims }, { headers: noStore });
}

export async function POST(request: Request) {
  const gate = await enforceExternalApi(request, "warranty_claims.create");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  const result = await workflows.warranty.createClaim(
    { ...parsed.body } as never,
    { actorUserId: actor.actorUserId },
  );
  return workflowResponse(result, 201);
}
