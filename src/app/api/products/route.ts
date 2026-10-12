import { NextResponse } from "next/server";

import {
  listApiProductsPage,
  listApiProductsByCategoryPage,
  getApiProductByRef,
  publicProductReadHeaders,
  resolveProductRow,
  type ProductRef,
} from "@/lib/api/products";
import { workflows } from "@/workflows";
import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { readJsonObject, workflowResponse, workflowInput } from "@/lib/api-auth/respond";
import { requireApiActor } from "@/lib/api-auth/actor";

/**
 * /api/products — external data API (ERP-friendly).
 *
 *   GET    list products (products:read; public-toggleable), OR look one up by
 *          reference: ?sku= / ?gtin= / ?externalRef= (caller picks the field).
 *   POST   create a product (products:write)                  → createProductWorkflow
 *   PUT    create-OR-update by reference (products:write)      → upsert by matchBy
 *   PATCH  update a product by productId (products:write)      → updateProductWorkflow
 *   DELETE archive by productId | externalRef | sku | gtin     → deleteProductWorkflow
 *
 * Reads expose the uuid `id`, `externalRef` and `stockQty` (ApiProduct) so an
 * ERP can round-trip & reconcile. Writes run the SAME workflows the dashboard
 * uses (actor = the key's owner); the workflow validates + dedupes (sku/gtin/
 * externalRef collisions → 409).
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
// Guards an id-form ref before it hits a `uuid` column: a non-uuid would raise
// 22P02. resolveProductRow runs OUTSIDE workflow() on the DELETE path, so an
// unguarded bad id there escapes as a framework 500 instead of a clean 400.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF_MAX = 120;

function parseIntParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

const noStore = { "Cache-Control": "no-store" } as const;

/** A trimmed, length-bounded reference value from the query string, or null. */
function refParam(params: URLSearchParams, key: string): string | null {
  const v = params.get(key)?.trim();
  if (!v) return null;
  return v.slice(0, REF_MAX);
}

export async function GET(request: Request) {
  const gate = await enforceExternalApi(request, "products.list");
  if (!gate.ok) return gate.response;

  const { searchParams } = new URL(request.url);

  // Reference lookup — ?externalRef= / ?sku= / ?gtin= (caller picks one). Returns
  // the single match (or empty). Keyed callers may see drafts (create-then-verify).
  const externalRef = refParam(searchParams, "externalRef");
  const sku = refParam(searchParams, "sku");
  const gtin = refParam(searchParams, "gtin");
  if (externalRef || sku || gtin) {
    const product = await getApiProductByRef(
      { externalRef, sku, gtin },
      { includeUnpublished: !gate.isPublic, public: gate.isPublic },
    );
    const headers = gate.isPublic ? { "Cache-Control": "private, max-age=0" } : noStore;
    return NextResponse.json(
      { products: product ? [product] : [], pagination: { limit: 1, offset: 0, count: product ? 1 : 0 } },
      { headers },
    );
  }

  const category = searchParams.get("category");
  if (category !== null && !SLUG_RE.test(category)) {
    return NextResponse.json({ error: "Slug de catégorie invalide." }, { status: 400, headers: noStore });
  }

  const limit = Math.min(Math.max(parseIntParam(searchParams.get("limit"), 24), 1), 100);
  const offset = Math.max(parseIntParam(searchParams.get("offset"), 0), 0);

  // Both branches paginate at the DB and enrich only the requested page.
  const { products, rawCount } = category
    ? await listApiProductsByCategoryPage(category, { limit, offset, public: gate.isPublic })
    : await listApiProductsPage({ limit, offset, public: gate.isPublic });

  // Public + anonymous → shared-cacheable; public + a session cookie → a
  // per-viewer body is possible → private (publicProductReadHeaders).
  const headers = gate.isPublic ? publicProductReadHeaders(request) : { "Cache-Control": "private, no-store" };

  // `count` = products returned; `rawCount` = the size of the underlying DB page
  // — page with `nextOffset` (offset + rawCount; null once a short raw page ends
  // the catalogue), never by `count < limit`: a page can resolve to fewer
  // products than its raw size (e.g. a row unpublished mid-read), so `count` is
  // not a reliable end-of-catalogue signal.
  return NextResponse.json(
    {
      products,
      pagination: {
        limit,
        offset,
        count: products.length,
        rawCount,
        nextOffset: rawCount < limit ? null : offset + rawCount,
      },
    },
    { headers },
  );
}

export async function POST(request: Request) {
  const gate = await enforceExternalApi(request, "products.create");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  const result = await workflows.catalog.createProduct(workflowInput(parsed.body), { actorUserId: actor.actorUserId });
  return workflowResponse(result, 201);
}

const MATCH_KEYS = ["externalRef", "sku", "gtin"] as const;
type MatchKey = (typeof MATCH_KEYS)[number];

/**
 * PUT — idempotent create-or-update keyed on a reference. The body names the key
 * via `matchBy` (externalRef | sku | gtin); if omitted it is inferred from the
 * single reference field present. The matched value must also be a field in the
 * body (it is what links/identifies the row).
 */
export async function PUT(request: Request) {
  const gate = await enforceExternalApi(request, "products.upsert");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  let matchBy = typeof body.matchBy === "string" ? (body.matchBy as string) : "";
  if (!matchBy) {
    // Infer when unambiguous: the single reference field present.
    const present = MATCH_KEYS.filter((k) => typeof body[k] === "string" && (body[k] as string).trim());
    if (present.length === 1) matchBy = present[0];
  }
  if (!MATCH_KEYS.includes(matchBy as MatchKey)) {
    return NextResponse.json(
      { error: "« matchBy » requis : externalRef | sku | gtin (avec la valeur correspondante dans le corps)." },
      { status: 400, headers: noStore },
    );
  }
  const value = body[matchBy];
  if (typeof value !== "string" || !value.trim()) {
    return NextResponse.json(
      { error: `« ${matchBy} » requis dans le corps pour l'upsert.` },
      { status: 400, headers: noStore },
    );
  }

  const existing = await resolveProductRow({ [matchBy]: value.trim() } as ProductRef);

  // matchBy is a control field, not a product column — drop it before the workflow.
  const { matchBy: _omit, ...fields } = body;

  if (existing) {
    const result = await workflows.catalog.updateProduct(
      workflowInput({ ...fields, productId: existing.id }),
      { actorUserId: actor.actorUserId },
    );
    return workflowResponse(result, 200);
  }
  const result = await workflows.catalog.createProduct(workflowInput(fields), { actorUserId: actor.actorUserId });
  return workflowResponse(result, 201);
}

export async function PATCH(request: Request) {
  const gate = await enforceExternalApi(request, "products.update");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  // Pass the raw body straight through — updateProductWorkflow only applies the
  // keys the caller actually sent (it guards against Zod `.partial()` defaults),
  // so a sparse patch never wipes unrelated fields.
  const result = await workflows.catalog.updateProduct(workflowInput(parsed.body), { actorUserId: actor.actorUserId });
  return workflowResponse(result);
}

export async function DELETE(request: Request) {
  const gate = await enforceExternalApi(request, "products.delete");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  // Resolve the target by any reference (query OR body): productId | externalRef
  // | sku | gtin. DELETE tolerates a missing/invalid body (readJsonObject never
  // throws), so query-only callers work too.
  const parsed = await readJsonObject(request);
  const body = parsed.ok ? parsed.body : ({} as Record<string, unknown>);
  const { searchParams } = new URL(request.url);
  const pick = (k: string): string | null => {
    const q = searchParams.get(k)?.trim();
    if (q) return q;
    const b = body[k];
    return typeof b === "string" && b.trim() ? b.trim() : null;
  };
  const ref: ProductRef = {
    productId: pick("productId") ?? pick("id"),
    externalRef: pick("externalRef"),
    sku: pick("sku"),
    gtin: pick("gtin"),
  };
  if (!ref.productId && !ref.externalRef && !ref.sku && !ref.gtin) {
    return NextResponse.json(
      { error: "Référence requise : productId | externalRef | sku | gtin." },
      { status: 400, headers: noStore },
    );
  }
  // Guard the id shape before the lookup — this resolve runs OUTSIDE workflow(),
  // so a non-uuid productId would 22P02 → framework 500 instead of a clean 400.
  if (ref.productId && !UUID_RE.test(ref.productId)) {
    return NextResponse.json({ error: "productId invalide." }, { status: 400, headers: noStore });
  }

  const existing = await resolveProductRow(ref);
  if (!existing) {
    return NextResponse.json({ error: "Produit introuvable." }, { status: 404, headers: noStore });
  }

  const result = await workflows.catalog.deleteProduct({ productId: existing.id }, { actorUserId: actor.actorUserId });
  return workflowResponse(result);
}
