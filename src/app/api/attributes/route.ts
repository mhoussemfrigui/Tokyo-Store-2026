import { NextResponse } from "next/server";

import { attributeService } from "@/modules/catalog/attribute/service";
import { workflows } from "@/workflows";
import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { readJsonObject, workflowResponse, workflowInput, pickId } from "@/lib/api-auth/respond";
import { requireApiActor } from "@/lib/api-auth/actor";

/**
 * /api/attributes — external data API.
 *
 *   GET    active attributes + their values (attributes:read; public-toggleable)
 *   POST   create an attribute, optionally seeding values (attributes:write)
 *   PATCH  update an attribute (attributes:write)
 *   DELETE archive an attribute (attributes:write)
 *
 * Attribute VALUES have their own endpoints at /api/attributes/values.
 */
function parseIntParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export async function GET(request: Request) {
  const gate = await enforceExternalApi(request, "attributes.list");
  if (!gate.ok) return gate.response;

  // Bound the response (mirrors /api/brands) — the attribute set is admin-
  // curated and small, but an external endpoint should never be unbounded.
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(parseIntParam(searchParams.get("limit"), 200), 1), 500);
  const offset = Math.max(parseIntParam(searchParams.get("offset"), 0), 0);

  const allActive = await attributeService.listActiveAttributes();
  const attributes = allActive.slice(offset, offset + limit);
  const valuesByAttr = await attributeService.listValuesForAttributes(attributes.map((a) => a.id));

  const payload = attributes.map((a) => ({
    id: a.id,
    slug: a.slug,
    name: a.name,
    kind: a.kind,
    displayOrder: a.display_order,
    isActive: a.is_active,
    values: (valuesByAttr.get(a.id) ?? []).map((v) => ({
      id: v.id,
      slug: v.slug,
      label: v.label,
      displayOrder: v.display_order,
      colorHex: v.color_hex,
    })),
  }));

  const headers = gate.isPublic
    ? { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" }
    : { "Cache-Control": "private, no-store" };

  return NextResponse.json({ attributes: payload }, { headers });
}

export async function POST(request: Request) {
  const gate = await enforceExternalApi(request, "attributes.create");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  const result = await workflows.catalog.createAttribute(workflowInput(parsed.body), { actorUserId: actor.actorUserId });
  return workflowResponse(result, 201);
}

export async function PATCH(request: Request) {
  const gate = await enforceExternalApi(request, "attributes.update");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  const result = await workflows.catalog.updateAttribute(workflowInput(parsed.body), { actorUserId: actor.actorUserId });
  return workflowResponse(result);
}

export async function DELETE(request: Request) {
  const gate = await enforceExternalApi(request, "attributes.delete");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  // DELETE tolerates a missing/invalid body — the id may come from the query
  // string. readJsonObject never throws, so just read its discriminated result.
  const parsed = await readJsonObject(request);
  const body = parsed.ok ? parsed.body : {};
  const attributeId = pickId(request, body, "attributeId", "id");
  if (!attributeId) {
    return NextResponse.json(
      { error: "« attributeId » requis (en requête ou dans le corps)." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const result = await workflows.catalog.deleteAttribute({ attributeId }, { actorUserId: actor.actorUserId });
  return workflowResponse(result);
}
