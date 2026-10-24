import { NextResponse } from "next/server";

import { searchService } from "@/modules/search";
import { getSearchConfig } from "@/modules/search/config";
import { mediaQueries } from "@/modules/media";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { searchHitHref } from "@/lib/search/href";
import { requireFirstParty } from "@/lib/api-auth/same-origin";
import { isSiteGatedForViewer } from "@/lib/site-mode/config";

/**
 * Public storefront search.
 *
 *   GET /api/store/search?q=apex+velocity     — multi-table results (per-kind cap = configured autocomplete limit)
 *   GET /api/store/search?q=apex&kinds=product — only products
 *
 * Backed by the cross-table FTS + pg_trgm hybrid in `@/modules/search`
 * (the generated `search_vector` tsvector columns + GIN/trigram indexes
 * live in the baseline SQL migration). The service fans out across
 * products / categories / brands / blog_posts / pages in
 * parallel and merges the results.
 *
 * Edge-cached briefly (10s) with stale-while-revalidate so a typed
 * autocomplete burst doesn't hammer Postgres for every keystroke, but
 * fresh admin edits still propagate within seconds.
 *
 * Search-log telemetry is fire-and-forget inside the service — this
 * route never blocks on it.
 */
const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=10, s-maxage=30, stale-while-revalidate=60",
} as const;

export async function GET(request: Request) {
  // First-party only: the storefront's own pages call this; external consumers
  // use the key-gated /api surface. (Cache-hits served by the CDN bypass this
  // by design — they only return already-public search data.)
  const notFirstParty = requireFirstParty(request);
  if (notFirstParty) return notFirstParty;

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const kindsParam = url.searchParams.get("kinds");

  // Maintenance / coming-soon: the store is closed, so search returns NOTHING
  // (the (shop) layout only gates pages — without this a pre-launch catalogue is
  // listable prefix by prefix; requireFirstParty is a speed bump, not auth).
  // Staff bypass like the layout (they preview the live store). `no-store` so the
  // empty answer is never CDN-cached past the re-opening.
  if (await isSiteGatedForViewer()) {
    return NextResponse.json(
      { hits: [], total: 0, query: q },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Cap public search to 60 requests / minute per IP. FTS + trigram
  // queries are cheap individually but scraping the catalog by sweeping
  // every prefix is a real DoS vector — and the GIN scan can chew CPU on
  // adversarial input even after the service-layer sanitisation. Checked
  // BEFORE the config read so a flood of too-short queries can't sidestep it.
  const ip =
    getClientIp(request.headers) ||
    "anon";
  const rl = await checkRateLimit({
    bucket: `search:ip:${ip}`,
    max: 60,
    windowSeconds: 60,
  });
  if (!rl.ok) {
    return NextResponse.json(
      { hits: [], total: 0, error: "rate_limited", query: q },
      {
        status: 429,
        headers: {
          "Cache-Control": "no-store",
          "Retry-After": String(Math.max(0, rl.resetAt - Math.floor(Date.now() / 1000))),
        },
      },
    );
  }

  // Admin-tunable search config (min length, autocomplete default limit, kind
  // toggles, weights, …). Never throws — falls back to code defaults.
  const cfg = await getSearchConfig();

  // Tight clamp so adversarial `?limit=-1` or `?limit=Infinity` can't smuggle
  // a 1-row result or burn the GIN scan. Default = configured autocomplete
  // limit. This is the autocomplete/dropdown surface, so it stays bounded to the
  // autocomplete ceiling (1–25); the larger 1–50 result_limit is honoured only
  // on /recherche, which calls searchService.search directly and bypasses this
  // route (the service's own per-kind cap is 50).
  const limitParam = url.searchParams.get("limit");
  const parsedLimit = limitParam != null ? Number.parseInt(limitParam, 10) : NaN;
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(parsedLimit) ? parsedLimit : cfg.autocompleteLimit, 25),
  );

  if (q.length < cfg.minQueryLength) {
    return NextResponse.json(
      { hits: [], total: 0, query: q },
      { headers: CACHE_HEADERS },
    );
  }

  try {
    const allowedKinds = [
      "product",
      "category",
      "brand",
      "blog_post",
      "page",
    ] as const;
    type Kind = (typeof allowedKinds)[number];
    const kinds = kindsParam
      ? (kindsParam
          .split(",")
          .map((k) => k.trim())
          .filter((k): k is Kind => (allowedKinds as readonly string[]).includes(k)))
      : undefined;

    const result = await searchService.search(q, {
      limit,
      kinds,
      ip,
      config: cfg,
      // Autocomplete keystrokes must NOT pollute the search-log analytics
      // (top-queries / zero-result → alias decisions): only the committed
      // /recherche search logs. See A-Z re-audit Phase 7.
      skipLog: true,
    });

    const searchHits = result.hits;
    const total = result.total;

    // Resolve media URLs + alt for any hits that carry an image_media_id. One
    // batched call to mediaQueries.resolveUrlAltMap — no N+1.
    const mediaIds = Array.from(
      new Set(
        searchHits
          .map((h) => h.image_media_id)
          .filter((x): x is string => !!x),
      ),
    );
    const mediaMap =
      mediaIds.length > 0
        ? await mediaQueries.resolveUrlAltMap(mediaIds)
        : new Map<string, { url: string; alt: string | null }>();

    const hits = searchHits.map((h) => ({
      kind: h.kind,
      id: h.id,
      slug: h.slug,
      title: h.title,
      snippet: h.snippet,
      href: searchHitHref(h.kind, h.slug),
      imageUrl: h.image_media_id ? mediaMap.get(h.image_media_id)?.url ?? null : null,
      // Médiathèque alt for the hit image (falls back to the title at render).
      imageAlt: h.image_media_id ? mediaMap.get(h.image_media_id)?.alt ?? null : null,
      // Product-only extras when present (price already promo-enriched by the
      // search service so it matches the listing cards / PDP / cart).
      priceCents:
        h.kind === "product"
          ? (h as typeof h & { price_cents: number }).price_cents
          : null,
      oldPriceCents:
        h.kind === "product"
          ? (h as typeof h & { old_price_cents: number | null }).old_price_cents ?? null
          : null,
      // Live availability for the dropdown stock dot (product hits only).
      inStock:
        h.kind === "product"
          ? (h as typeof h & { in_stock: boolean }).in_stock
          : null,
    }));

    // Search results are the public catalogue for every viewer, so they're safe
    // to share on the CDN.
    return NextResponse.json(
      {
        query: q,
        total,
        hits,
      },
      { headers: CACHE_HEADERS },
    );
  } catch (err) {
    // We never want a search box to 500: return an empty result, log the
    // offending input, and let the user retry. CRITICAL: do NOT cache the
    // empty failure — a cached failure would poison the edge cache for the
    // full TTL, returning "no results" to every user issuing the same query.
    // `no-store` ensures the next request retries the origin instead of
    // being served a stale empty array.
    console.error("[api/store/search] failure", { q, err });
    return NextResponse.json(
      { hits: [], total: 0, query: q, error: "search_unavailable" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
