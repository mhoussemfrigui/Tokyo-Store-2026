import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { requireApiActor } from "@/lib/api-auth/actor";
import { readJsonObject, workflowResponse } from "@/lib/api-auth/respond";
import { workflows } from "@/workflows";
import {
  resolveApiClaim,
  serializeWarrantyClaim,
  orderNumberFor,
} from "@/lib/api/warranty-claims";

/**
 * /api/warranty-claims/[id] — one claim. `[id]` = uuid or external ERP reference.
 *
 *   GET    the full claim (warranty:read).
 *   PATCH  advance OR close it (warranty:write) — the ERP's two-way write-back:
 *          - { resolution:'repaired'|'replaced'|'refunded'|'rejected', resolutionNote? }
 *            → resolveClaim (terminal);
 *          - otherwise { status?, comment?, reasonCode?, externalRef? } → updateClaim.
 */
const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "warranty_claims.get");
  if (!gate.ok) return gate.response;

  const { id } = await params;
  const claim = await resolveApiClaim(id);
  if (!claim) {
    return NextResponse.json({ error: "Réclamation introuvable." }, { status: 404, headers: noStore });
  }
  return NextResponse.json(
    { claim: serializeWarrantyClaim(claim, await orderNumberFor(claim.order_id)) },
    { headers: noStore },
  );
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await enforceExternalApi(request, "warranty_claims.update");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const { id } = await params;
  const claim = await resolveApiClaim(id);
  if (!claim) {
    return NextResponse.json({ error: "Réclamation introuvable." }, { status: 404, headers: noStore });
  }
  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  // A `resolution` in the body means "close the claim"; otherwise it's an update.
  // The claim id is the RESOLVED uuid — an externalRef in the path still targets
  // exactly this claim (never a status change on the wrong one).
  const result =
    parsed.body.resolution !== undefined
      ? await workflows.warranty.resolveClaim(
          { ...parsed.body, claimId: claim.id } as never,
          { actorUserId: actor.actorUserId },
        )
      : await workflows.warranty.updateClaim(
          { ...parsed.body, claimId: claim.id } as never,
          { actorUserId: actor.actorUserId },
        );
  return workflowResponse(result);
}
