import { NextResponse } from "next/server";

import { enforceExternalApi } from "@/lib/api-auth/enforce";
import { getApiProductReviews } from "@/lib/api/reviews";
import type { ProductRef } from "@/lib/api/products";

const REF_MAX = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const noStore = { "Cache-Control": "no-store" } as const;

function ref(params: URLSearchParams, key: string): string | null {
  const v = params.get(key)?.trim();
  return v ? v.slice(0, REF_MAX) : null;
}

/**
 * GET /api/reviews — approved reviews + aggregate for one product (reviews:read;
 * public-toggleable). Address the product by any reference:
 *   ?product= (slug) | ?slug= | ?sku= | ?gtin= | ?externalRef= | ?id=
 * Optional ?rating=1-5 (single bucket), ?limit= (1-100, default 50).
 * Internal review fields (user id, source customer/manual/ai, status) are never
 * exposed. 400 with no reference; 404 if the reference resolves to nothing.
 */
export async function GET(request: Request) {
  const gate = await enforceExternalApi(request, "reviews.list");
  if (!gate.ok) return gate.response;

  const { searchParams } = new URL(request.url);
  const productId = ref(searchParams, "id") ?? ref(searchParams, "productId");
  // A non-UUID id would hit `WHERE id = $1` against the uuid column and raise
  // Postgres 22P02 → an unhandled 500; reject early with a clean 400 (mirrors
  // the categories / stock / brands routes).
  if (productId && !UUID_RE.test(productId)) {
    return NextResponse.json({ error: "id produit invalide." }, { status: 400, headers: noStore });
  }
  const productRef: ProductRef = {
    productId,
    externalRef: ref(searchParams, "externalRef"),
    sku: ref(searchParams, "sku"),
    gtin: ref(searchParams, "gtin"),
    slug: ref(searchParams, "slug") ?? ref(searchParams, "product"),
  };
  if (!productRef.productId && !productRef.externalRef && !productRef.sku && !productRef.gtin && !productRef.slug) {
    return NextResponse.json(
      { error: "Référence produit requise (?product= / ?slug= / ?sku= / ?gtin= / ?externalRef= / ?id=)." },
      { status: 400, headers: noStore },
    );
  }

  const ratingRaw = Number(searchParams.get("rating"));
  const rating = Number.isInteger(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : undefined;
  // `Number(null)` is 0 (finite), so an ABSENT ?limit would clamp to 1 instead of
  // the intended default — treat absent/blank as NaN → default 50.
  const limitParam = searchParams.get("limit");
  const limitRaw = limitParam === null || limitParam.trim() === "" ? NaN : Number(limitParam);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 50;

  // A public (toggled) caller can't read drafts; a trusted keyed caller can —
  // parity with the products by-ref API. `public` also applies the
  // reviews.enabled switch (OFF → empty).
  const result = await getApiProductReviews(productRef, {
    rating,
    limit,
    includeUnpublished: !gate.isPublic,
    public: gate.isPublic,
  });
  if (!result) {
    return NextResponse.json({ error: "Produit introuvable." }, { status: 404, headers: noStore });
  }

  const headers = gate.isPublic
    ? { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=300" }
    : { "Cache-Control": "private, no-store" };
  return NextResponse.json(result, { headers });
}
