import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { listApiBlogPosts, listApiBlogCategories } from "@/lib/api/blog";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * GET /api/blog — published blog posts (blog:read; public-toggleable).
 *   ?categories=1            → the active category list (slug + name)
 *   ?limit= (1-50) &cursor= &category=<slug>  → paginated post list
 * Only published posts are ever returned (the underlying query is published-only),
 * so there is no draft-leak even for keyed callers.
 */
export async function GET(request: Request) {
  const gate = await enforceExternalApi(request, "blog.list");
  if (!gate.ok) return gate.response;

  const { searchParams } = new URL(request.url);
  const cacheHeaders = gate.isPublic
    ? { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" }
    : { "Cache-Control": "private, no-store" };

  if (searchParams.get("categories") === "1") {
    return NextResponse.json({ categories: await listApiBlogCategories() }, { headers: cacheHeaders });
  }

  const limitRaw = Number(searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 50) : 24;
  const cursor = searchParams.get("cursor")?.trim() || undefined;
  const category = searchParams.get("category")?.trim() || undefined;
  if (category && !SLUG_RE.test(category)) {
    return NextResponse.json({ error: "Slug de catégorie invalide." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  const { items, nextCursor } = await listApiBlogPosts({ limit, cursor, categorySlug: category });
  return NextResponse.json({ items, nextCursor }, { headers: cacheHeaders });
}
