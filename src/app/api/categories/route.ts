import { NextResponse } from "next/server";

import {
  listCategories,
  listApiCategories,
  getApiCategoryByRef,
  resolveCategoryRow,
  type CategoryRef,
} from "@/lib/api/categories";
import { workflows } from "@/workflows";
import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { readJsonObject, workflowResponse, workflowInput } from "@/lib/api-auth/respond";
import { requireApiActor } from "@/lib/api-auth/actor";

/**
 * /api/categories — external data API (ERP-friendly).
 *
 *   GET    list categories (categories:read; public-toggleable):
 *            • default → the storefront tree (active roots + nested children),
 *            • ?flat=1 → a FLAT list of every live category (id/externalRef/parentId),
 *            • ?externalRef= / ?slug= / ?id= → a single category by reference.
 *   POST   create a category (categories:write)                → createCategoryWorkflow
 *   PUT    create-OR-update by reference (categories:write)     → upsert by matchBy
 *   PATCH  update a category by categoryId (categories:write)   → updateCategoryWorkflow
 *   DELETE archive by categoryId | externalRef | slug          → deleteCategoryWorkflow
 *
 * The by-reference reads expose the uuid `id`, `externalRef` and `parentId`
 * (ApiCategory) so an ERP can round-trip & reconcile the tree. Writes run the
 * SAME workflows the dashboard uses (actor = the key's owner); the workflow
 * validates + dedupes (slug / externalRef collisions → 409).
 */
const REF_MAX = 120;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { "Cache-Control": "no-store" } as const;

/** A trimmed, length-bounded reference value from the query string, or null. */
function refParam(params: URLSearchParams, key: string): string | null {
  const v = params.get(key)?.trim();
  if (!v) return null;
  return v.slice(0, REF_MAX);
}

export async function GET(request: Request) {
  const gate = await enforceExternalApi(request, "categories.list");
  if (!gate.ok) return gate.response;

  const { searchParams } = new URL(request.url);

  // Reference lookup — ?externalRef= / ?slug= / ?id= (caller picks one). Returns
  // the single match (or empty) as the flat ApiCategory shape.
  const externalRef = refParam(searchParams, "externalRef");
  const slug = refParam(searchParams, "slug");
  const categoryId = refParam(searchParams, "id") ?? refParam(searchParams, "categoryId");
  if (externalRef || slug || categoryId) {
    if (slug && !SLUG_RE.test(slug)) {
      return NextResponse.json({ error: "Slug de catégorie invalide." }, { status: 400, headers: noStore });
    }
    // Validate id shape BEFORE the lookup — a non-uuid would hit a `WHERE id = $1`
    // bound to the uuid column and raise an unhandled 22P02 → 500.
    if (categoryId && !UUID_RE.test(categoryId)) {
      return NextResponse.json({ error: "id de catégorie invalide." }, { status: 400, headers: noStore });
    }
    // Public callers see only active categories; keyed (ERP) callers see drafts.
    const category = await getApiCategoryByRef(
      { externalRef, slug, categoryId },
      { activeOnly: gate.isPublic },
    );
    const headers = gate.isPublic ? { "Cache-Control": "private, max-age=0" } : noStore;
    return NextResponse.json({ categories: category ? [category] : [], count: category ? 1 : 0 }, { headers });
  }

  const headers = gate.isPublic
    ? { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" }
    : { "Cache-Control": "private, no-store" };

  // ?flat=1 → a flat ApiCategory list; otherwise the nested storefront tree
  // (active-only, back-compat default). On the PUBLIC path the flat list is
  // active-only too, so it never leaks inactive/draft categories under a
  // shareable cache header; keyed ERP callers get the full set.
  if (searchParams.get("flat") === "1") {
    const categories = await listApiCategories({ activeOnly: gate.isPublic });
    return NextResponse.json({ categories, count: categories.length }, { headers });
  }

  const categories = await listCategories();
  return NextResponse.json({ categories }, { headers });
}

export async function POST(request: Request) {
  const gate = await enforceExternalApi(request, "categories.create");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  const result = await workflows.catalog.createCategory(workflowInput(parsed.body), { actorUserId: actor.actorUserId });
  return workflowResponse(result, 201);
}

const MATCH_KEYS = ["externalRef", "slug"] as const;
type MatchKey = (typeof MATCH_KEYS)[number];

/**
 * PUT — idempotent create-or-update keyed on a reference. The body names the key
 * via `matchBy` (externalRef | slug); if omitted it is inferred from the single
 * reference field present. The matched value must also be a field in the body
 * (it identifies/links the row). A matched existing row is updated; otherwise a
 * new category is created.
 */
export async function PUT(request: Request) {
  const gate = await enforceExternalApi(request, "categories.upsert");
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

  const existing = await resolveCategoryRow({ [matchBy]: value.trim() } as CategoryRef);

  // matchBy is a control field, not a category column — drop it before the workflow.
  const { matchBy: _omit, ...fields } = body;

  if (existing) {
    const result = await workflows.catalog.updateCategory(
      workflowInput({ ...fields, categoryId: existing.id }),
      { actorUserId: actor.actorUserId },
    );
    return workflowResponse(result, 200);
  }
  const result = await workflows.catalog.createCategory(workflowInput(fields), { actorUserId: actor.actorUserId });
  return workflowResponse(result, 201);
}

export async function PATCH(request: Request) {
  const gate = await enforceExternalApi(request, "categories.update");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  const parsed = await readJsonObject(request);
  if (!parsed.ok) return parsed.response;

  const result = await workflows.catalog.updateCategory(workflowInput(parsed.body), { actorUserId: actor.actorUserId });
  return workflowResponse(result);
}

export async function DELETE(request: Request) {
  const gate = await enforceExternalApi(request, "categories.delete");
  if (!gate.ok) return gate.response;
  const actor = requireApiActor(gate);
  if (!actor.ok) return actor.response;

  // DELETE tolerates a missing/invalid body — the reference may come from the
  // query string. Resolve by categoryId | externalRef | slug (query OR body).
  const parsed = await readJsonObject(request);
  const body = parsed.ok ? parsed.body : ({} as Record<string, unknown>);
  const { searchParams } = new URL(request.url);
  const pick = (k: string): string | null => {
    const q = searchParams.get(k)?.trim();
    if (q) return q;
    const b = body[k];
    return typeof b === "string" && b.trim() ? b.trim() : null;
  };
  const ref: CategoryRef = {
    categoryId: pick("categoryId") ?? pick("id"),
    externalRef: pick("externalRef"),
    slug: pick("slug"),
  };
  if (!ref.categoryId && !ref.externalRef && !ref.slug) {
    return NextResponse.json(
      { error: "Référence requise : categoryId | externalRef | slug (en requête ou dans le corps)." },
      { status: 400, headers: noStore },
    );
  }
  // Guard the id shape BEFORE the lookup (mirrors the GET path) — resolveCategoryRow
  // runs OUTSIDE workflow(), so a non-uuid categoryId would hit `WHERE id = $1` on
  // the uuid column and raise an unhandled 22P02 → framework 500, not a clean 400.
  if (ref.categoryId && !UUID_RE.test(ref.categoryId)) {
    return NextResponse.json({ error: "id de catégorie invalide." }, { status: 400, headers: noStore });
  }

  const existing = await resolveCategoryRow(ref);
  if (!existing) {
    return NextResponse.json({ error: "Catégorie introuvable." }, { status: 404, headers: noStore });
  }

  const result = await workflows.catalog.deleteCategory({ categoryId: existing.id }, { actorUserId: actor.actorUserId });
  return workflowResponse(result);
}
