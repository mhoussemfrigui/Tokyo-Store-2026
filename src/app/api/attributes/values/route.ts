import { NextResponse } from "next/server";

import { workflows } from "@/workflows";
import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { readJsonObject, workflowResponse, workflowInput, pickId } from "@/lib/api-auth/respond";
import { requireApiActor } from "@/lib/api-auth/actor";

/**
 * /api/attributes/values — manage individual attribute values (attributes:write).
 *
 *   POST   create a value ({ attributeId, label, slug?, displayOrder? })
 *   PATCH  update a value ({ valueId, label?, slug?, displayOrder? })
 *   DELETE delete a value (id in query or body)
 *
 * Read values via GET /api/attributes (they're nested under each attribute).
 */
export async function POST(request: Request) {
  const gate = await enforceExternalApi(request, "attributes.value.create");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  const result = await workflows.catalog.createAttributeValue(workflowInput(parsed.body), { actorUserId: actor.actorUserId });
  return workflowResponse(result, 201);
}

export async function PATCH(request: Request) {
  const gate = await enforceExternalApi(request, "attributes.value.update");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  const result = await workflows.catalog.updateAttributeValue(workflowInput(parsed.body), { actorUserId: actor.actorUserId });
  return workflowResponse(result);
}

export async function DELETE(request: Request) {
  const gate = await enforceExternalApi(request, "attributes.value.delete");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  // DELETE tolerates a missing/invalid body — the id may come from the query
  // string. readJsonObject never throws, so just read its discriminated result.
  const parsed = await readJsonObject(request);
  const body = parsed.ok ? parsed.body : {};
  const valueId = pickId(request, body, "valueId", "id");
  if (!valueId) {
    return NextResponse.json(
      { error: "« valueId » requis (en requête ou dans le corps)." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await workflows.catalog.deleteAttributeValue({ valueId }, { actorUserId: actor.actorUserId });
  return workflowResponse(result);
}
