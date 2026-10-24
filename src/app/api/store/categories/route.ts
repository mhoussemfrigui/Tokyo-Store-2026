import { NextResponse } from "next/server";

import { catalogSource } from "@/storefront/lib/data";
import { requireFirstParty } from "@/lib/api-auth/same-origin";
import { isSiteGatedForViewer } from "@/lib/site-mode/config";

/**
 * First-party live root categories ({slug, label, count}) for client surfaces — the
 * home « Découvrez notre sélection » universe tabs. Reads catalogSource (Postgres), so
 * the universes mirror the live taxonomy with no bundled snapshot. Edge-cached a little.
 */
const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=30, s-maxage=120, stale-while-revalidate=300",
} as const;

export async function GET(request: Request) {
  const notFirstParty = requireFirstParty(request);
  if (notFirstParty) return notFirstParty;

  if (await isSiteGatedForViewer()) {
    return NextResponse.json({ categories: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    const categories = await catalogSource.listCategories();
    return NextResponse.json({ categories }, { headers: CACHE_HEADERS });
  } catch (err) {
    console.error("[api/store/categories] failure", { err });
    return NextResponse.json(
      { categories: [], error: "unavailable" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
