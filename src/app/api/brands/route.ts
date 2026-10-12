import { NextResponse } from "next/server";

import {
  listApiBrands,
  getApiBrandByRef,
  resolveBrandRow,
  type BrandRef,
} from "@/lib/api/brands";
import { workflows } from "@/workflows";
import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { readJsonObject, workflowResponse, workflowInput } from "@/lib/api-auth/respond";
import { requireApiActor } from "@/lib/api-auth/actor";

/**
 * /api/brands — external data API (ERP-friendly).
 *
 *   GET    list brands (brands:read; public-toggleable) — ?search=&limit=&offset=,
 *          OR a single brand by reference: ?externalRef= / ?slug= / ?id=.
 *   POST   create a brand (brands:write)                 → createBrandWorkflow
 *   PUT    create-OR-update by reference (brands:write)  → upsert by matchBy
 *   PATCH  update a brand by brandId (brands:write)      → updateBrandWorkflow
 *   DELETE archive by brandId | externalRef | slug       → deleteBrandWorkflow
 *
 * Reads expose the uuid `id` + `externalRef` (ApiBrand) so an ERP can round-trip
 * & reconcile. The public path is active-only (never leaks inactive/draft brands
 * under the shareable cache header); keyed callers see drafts.
 */
const REF_MAX = 120;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { "Cache-Control": "no-store" } as const;

function refParam(params: URLSearchParams, key: string): string | null {
  const v = params.get(key)?.trim();
  if (!v) return null;
  return v.slice(0, REF_MAX);
}

function parseIntParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export async function GET(request: Request) {
  const gate = await enforceExternalApi(request, "brands.list");
  if (!gate.ok) return gate.response;

  const { searchParams } = new URL(request.url);

  // Reference lookup — ?externalRef= / ?slug= / ?id= (caller picks one).
  const externalRef = refParam(searchParams, "externalRef");
  const slug = refParam(searchParams, "slug");
  const brandId = refParam(searchParams, "id") ?? refParam(searchParams, "brandId");
  if (externalRef || slug || brandId) {
    if (slug && !SLUG_RE.test(slug)) {
      return NextResponse.json({ error: "Slug de marque invalide." }, { status: 400, headers: noStore });
    }
    if (brandId && !UUID_RE.test(brandId)) {
      return NextResponse.json({ error: "id de marque invalide." }, { status: 400, headers: noStore });
    }
    const brand = await getApiBrandByRef({ externalRef, slug, brandId }, { activeOnly: gate.isPublic });
    const headers = gate.isPublic ? { "Cache-Control": "private, max-age=0" } : noStore;
    return NextResponse.json({ brands: brand ? [brand] : [], count: brand ? 1 : 0 }, { headers });
  }

  // Bounded search + paginated list. Public path is active-only.
  const search = refParam(searchParams, "search") ?? undefined;
  const limit = Math.min(Math.max(parseIntParam(searchParams.get("limit"), 200), 1), 500);
  const offset = Math.max(parseIntParam(searchParams.get("offset"), 0), 0);
  const brands = await listApiBrands({ search, limit, offset, activeOnly: gate.isPublic });
  const headers = gate.isPublic
    ? { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" }
    : { "Cache-Control": "private, no-store" };

  return NextResponse.json({ brands, pagination: { limit, offset, count: brands.length } }, { headers });
}

export async function POST(request: Request) {
  const gate = await enforceExternalApi(request, "brands.create");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  const result = await workflows.catalog.createBrand(workflowInput(parsed.body), { actorUserId: actor.actorUserId });
  return workflowResponse(result, 201);
}

const MATCH_KEYS = ["externalRef", "slug"] as const;
type MatchKey = (typeof MATCH_KEYS)[number];

/**
 * PUT — idempotent create-or-update keyed on a reference. The body names the key
 * via `matchBy` (externalRef | slug); inferred from the single ref field present
 * when omitted. The matched value must also be a body field.
 */
export async function PUT(request: Request) {
  const gate = await enforceExternalApi(request, "brands.upsert");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  let matchBy = typeof body.matchBy === "string" ? (body.matchBy as string) : "";
  if (!matchBy) {
    const present = MATCH_KEYS.filter((k) => typeof body[k] === "string" && (body[k] as string).trim());
    if (present.length === 1) matchBy = present[0];
  }
  if (!MATCH_KEYS.includes(matchBy as MatchKey)) {
    return NextResponse.json(
      { error: "« matchBy » requis : externalRef | slug (avec la valeur correspondante dans le corps)." },
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

  const existing = await resolveBrandRow({ [matchBy]: value.trim() } as BrandRef);
  // matchBy is a control field, not a brand column — drop it before the workflow.
  const { matchBy: _omit, ...fields } = body;

  if (existing) {
    const result = await workflows.catalog.updateBrand(
      workflowInput({ ...fields, brandId: existing.id }),
      { actorUserId: actor.actorUserId },
    );
    return workflowResponse(result, 200);
  }
  const result = await workflows.catalog.createBrand(workflowInput(fields), { actorUserId: actor.actorUserId });
  return workflowResponse(result, 201);
}

export async function PATCH(request: Request) {
  const gate = await enforceExternalApi(request, "brands.update");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  const result = await workflows.catalog.updateBrand(workflowInput(parsed.body), { actorUserId: actor.actorUserId });
  return workflowResponse(result);
}

export async function DELETE(request: Request) {
  const gate = await enforceExternalApi(request, "brands.delete");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  // Resolve by any reference (query OR body): brandId | externalRef | slug.
  const parsed = await readJsonObject(request);
  const body = parsed.ok ? parsed.body : ({} as Record<string, unknown>);
  const { searchParams } = new URL(request.url);
  const pick = (k: string): string | null => {
    const q = searchParams.get(k)?.trim();
    if (q) return q;
    const b = body[k];
    return typeof b === "string" && b.trim() ? b.trim() : null;
  };
  const ref: BrandRef = {
    brandId: pick("brandId") ?? pick("id"),
    externalRef: pick("externalRef"),
    slug: pick("slug"),
  };
  if (!ref.brandId && !ref.externalRef && !ref.slug) {
    return NextResponse.json(
      { error: "Référence requise : brandId | externalRef | slug (en requête ou dans le corps)." },
      { status: 400, headers: noStore },
    );
  }
  // Guard the id shape BEFORE the lookup (mirrors the GET path) — resolveBrandRow
  // runs OUTSIDE workflow(), so a non-uuid brandId would hit `WHERE id = $1` on the
  // uuid column and raise an unhandled 22P02 → framework 500, not a clean 400.
  if (ref.brandId && !UUID_RE.test(ref.brandId)) {
    return NextResponse.json({ error: "id de marque invalide." }, { status: 400, headers: noStore });
  }

  const existing = await resolveBrandRow(ref);
  if (!existing) {
    return NextResponse.json({ error: "Marque introuvable." }, { status: 404, headers: noStore });
  }

  const result = await workflows.catalog.deleteBrand({ brandId: existing.id }, { actorUserId: actor.actorUserId });
  return workflowResponse(result);
}
