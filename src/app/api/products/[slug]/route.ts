import { NextResponse } from "next/server";

import { getApiProductByRef, publicProductReadHeaders } from "@/lib/api/products";
import { enforceExternalApi } from "@/lib/api-auth/enforce";

/**
 * GET /api/products/:slug — product by slug (products:read; public-toggleable).
 * Returns the ApiProduct (with id / externalRef / stockQty). A TRUSTED keyed
 * caller (route not public) may read a DRAFT — so a product created via the API
 * (publish defaults to false) can be fetched back; public callers get 404 for
 * unpublished, matching every other public read.
 */
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const gate = await enforceExternalApi(request, "products.get");
  if (!gate.ok) return gate.response;

  const { slug } = await context.params;
  const product = await getApiProductByRef(
    { slug },
    { includeUnpublished: !gate.isPublic, public: gate.isPublic },
  );

  if (!product) {
    return NextResponse.json(
      { error: "Produit introuvable." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Public: a request carrying a session cookie may get a per-viewer body →
  // private; shared-cacheable only when anonymous (publicProductReadHeaders).
  const headers = gate.isPublic ? publicProductReadHeaders(request) : { "Cache-Control": "private, no-store" };

  return NextResponse.json({ product }, { headers });
}
