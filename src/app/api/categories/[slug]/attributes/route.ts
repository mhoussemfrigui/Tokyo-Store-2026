import { NextResponse } from "next/server";

import { resolveCategoryRow, type CategoryRef } from "@/lib/api/categories";
import { attributeService } from "@/modules/catalog/attribute/service";
import { workflows } from "@/workflows";
import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { readJsonObject, workflowResponse, workflowInput } from "@/lib/api-auth/respond";
import { requireApiActor } from "@/lib/api-auth/actor";

/**
 * /api/categories/:slug/attributes — the attributes a category exposes as
 * filters (the `category_attribute_filters` M2M).
 *
 *   GET  the ordered attribute ids opted-in for the category (categories:read;
 *        public-toggleable).
 *   PUT  replace the whole set (categories:write) via the setCategoryFilters
 *        workflow, which validates every attribute id is live before wiring.
 *
 * The path segment is the category SLUG by default; `?by=externalRef|id`
 * (query, or `by` in the PUT body) addresses by another reference.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { "Cache-Control": "no-store" } as const;

function categoryRefFromPath(by: string | null, value: string): CategoryRef | null {
  const v = value.trim();
  if (!v) return null;
  switch ((by ?? "slug").toLowerCase()) {
    case "externalref":
      return { externalRef: v };
    case "id":
    case "categoryid":
      return UUID_RE.test(v) ? { categoryId: v } : null;
    default:
      return { slug: v };
  }
}

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const gate = await enforceExternalApi(request, "categories.attributes.get");
  if (!gate.ok) return gate.response;

  const { slug } = await context.params;
  const { searchParams } = new URL(request.url);
  const ref = categoryRefFromPath(searchParams.get("by"), slug);
  if (!ref) return NextResponse.json({ error: "Référence catégorie invalide." }, { status: 400, headers: noStore });

  const row = await resolveCategoryRow(ref);
  if (!row || (gate.isPublic && !row.is_active)) {
    return NextResponse.json({ error: "Catégorie introuvable." }, { status: 404, headers: noStore });
  }

  const attributeIds = await attributeService.listCategoryFilters(row.id);

  const headers = gate.isPublic
    ? { "Cache-Control": "private, max-age=0" }
    : { "Cache-Control": "private, no-store" };

  return NextResponse.json({ category: { id: row.id, slug: row.slug }, attributeIds }, { headers });
}

export async function PUT(request: Request, context: { params: Promise<{ slug: string }> }) {
  const gate = await enforceExternalApi(request, "categories.attributes.set");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const { slug } = await context.params;
  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const by = typeof body.by === "string" ? body.by : new URL(request.url).searchParams.get("by");
  const ref = categoryRefFromPath(by, slug);
  if (!ref) return NextResponse.json({ error: "Référence catégorie invalide." }, { status: 400, headers: noStore });

  const row = await resolveCategoryRow(ref);
  if (!row) return NextResponse.json({ error: "Catégorie introuvable." }, { status: 404, headers: noStore });

  if (!Array.isArray(body.attributeIds)) {
    return NextResponse.json(
      { error: "« attributeIds » (tableau) requis." },
      { status: 400, headers: noStore },
    );
  }

  const result = await workflows.catalog.setCategoryFilters(
    workflowInput({ categoryId: row.id, attributeIds: body.attributeIds }),
    { actorUserId: actor.actorUserId },
  );
  return workflowResponse(result);
}
