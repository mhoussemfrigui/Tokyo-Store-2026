import { NextResponse } from "next/server";

import { resolveProductRow, type ProductRef } from "@/lib/api/products";
import { attributeService } from "@/modules/catalog/attribute/service";
import { validateAttributeRefs } from "@/lib/api/attribute-validation";
import { workflows } from "@/workflows";
import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { readJsonObject, workflowResponse, workflowInput } from "@/lib/api-auth/respond";
import { requireApiActor } from "@/lib/api-auth/actor";

/**
 * /api/products/:slug/attributes — a product's attribute attribution.
 *
 *   GET  the product's assigned attribute VALUE ids + its number/text SCALARS
 *        (products:read; public-toggleable).
 *   PUT  replace the value set and/or set scalars (products:write). Runs the
 *        SAME updateProduct workflow the dashboard uses, so validation, the
 *        audit trail and cache invalidation all fire.
 *
 * The path segment is the product SLUG by default; `?by=sku|gtin|externalRef|id`
 * (query, or `by` in the PUT body) addresses by another reference so an ERP can
 * sync without knowing the slug.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { "Cache-Control": "no-store" } as const;

/** Map the path value + `by` selector to an explicit product reference. */
function productRefFromPath(by: string | null, value: string): ProductRef | null {
  const v = value.trim();
  if (!v) return null;
  switch ((by ?? "slug").toLowerCase()) {
    case "sku":
      return { sku: v };
    case "gtin":
      return { gtin: v };
    case "externalref":
      return { externalRef: v };
    case "id":
    case "productid":
      // Validate UUID shape so a bad id never hits `WHERE id = $1` (uuid) → 22P02 → 500.
      return UUID_RE.test(v) ? { productId: v } : null;
    default:
      return { slug: v };
  }
}

export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const gate = await enforceExternalApi(request, "products.attributes.get");
  if (!gate.ok) return gate.response;

  const { slug } = await context.params;
  const { searchParams } = new URL(request.url);
  const ref = productRefFromPath(searchParams.get("by"), slug);
  if (!ref) return NextResponse.json({ error: "Référence produit invalide." }, { status: 400, headers: noStore });

  const row = await resolveProductRow(ref);
  // Public callers only see published products; a keyed caller may read a draft
  // to verify a create.
  if (!row || (gate.isPublic && !row.is_published)) {
    return NextResponse.json({ error: "Produit introuvable." }, { status: 404, headers: noStore });
  }

  const [valueIds, scalars] = await Promise.all([
    attributeService.listValueIdsForProduct(row.id),
    attributeService.getScalarsForProduct(row.id),
  ]);

  const headers = gate.isPublic
    ? { "Cache-Control": "private, max-age=0" }
    : { "Cache-Control": "private, no-store" };

  return NextResponse.json(
    {
      product: { id: row.id, slug: row.slug },
      attributeValueIds: valueIds,
      scalars: scalars.map((s) => ({
        attributeId: s.attribute_id,
        numericValue: s.numeric_value != null ? Number(s.numeric_value) : null,
        textValue: s.text_value ?? null,
      })),
    },
    { headers },
  );
}

export async function PUT(request: Request, context: { params: Promise<{ slug: string }> }) {
  const gate = await enforceExternalApi(request, "products.attributes.set");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const { slug } = await context.params;
  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  const by = typeof body.by === "string" ? body.by : new URL(request.url).searchParams.get("by");
  const ref = productRefFromPath(by, slug);
  if (!ref) return NextResponse.json({ error: "Référence produit invalide." }, { status: 400, headers: noStore });

  const row = await resolveProductRow(ref);
  if (!row) return NextResponse.json({ error: "Produit introuvable." }, { status: 404, headers: noStore });

  // Only forward the keys the caller actually sent — the updateProduct workflow
  // gates each association on presence, so omitting one leaves it untouched
  // (attributeValueIds is REPLACE — an empty array clears all; each
  // attributeScalars entry upserts, or clears when both fields are empty).
  const input: Record<string, unknown> = { productId: row.id };
  if (Array.isArray(body.attributeValueIds)) input.attributeValueIds = body.attributeValueIds;
  if (Array.isArray(body.attributeScalars)) input.attributeScalars = body.attributeScalars;
  if (input.attributeValueIds === undefined && input.attributeScalars === undefined) {
    return NextResponse.json(
      { error: "Fournir « attributeValueIds » (tableau) et/ou « attributeScalars » (tableau)." },
      { status: 400, headers: noStore },
    );
  }

  // Validate referenced ids against the LIVE catalogue BEFORE writing, so an
  // unknown-but-well-formed UUID returns a clean 400 (mirroring the category
  // endpoint) instead of hitting an FK 23503 → opaque 500 deep in the workflow.
  const valErr = await validateAttributeRefs(
    Array.isArray(body.attributeValueIds) ? (body.attributeValueIds as unknown[]) : null,
    Array.isArray(body.attributeScalars) ? (body.attributeScalars as unknown[]) : null,
  );
  if (valErr) return NextResponse.json({ error: valErr }, { status: 400, headers: noStore });

  const result = await workflows.catalog.updateProduct(workflowInput(input), { actorUserId: actor.actorUserId });
  return workflowResponse(result);
}
