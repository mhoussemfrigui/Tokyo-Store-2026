import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { getApiBlogPost } from "@/lib/api/blog";

// Same shape as the list route's category check: a real slug is lowercase
// alphanumerics + hyphens, ≤81 chars. Reject anything else fast (404) instead
// of running a doomed DB lookup — defence-in-depth alongside creation-time
// validation, and parity with /api/blog?category=.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * GET /api/blog/:slug — a published blog post by slug (blog:read; public-toggleable).
 * 404 for unknown or unpublished slugs (the read is published-only).
 */
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const gate = await enforceExternalApi(request, "blog.get");
  if (!gate.ok) return gate.response;

  const { slug } = await context.params;
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json(
      { error: "Article introuvable." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  const post = await getApiBlogPost(slug);
  if (!post) {
    return NextResponse.json(
      { error: "Article introuvable." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const headers = gate.isPublic
    ? { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600" }
    : { "Cache-Control": "private, no-store" };
  return NextResponse.json({ post }, { headers });
}
