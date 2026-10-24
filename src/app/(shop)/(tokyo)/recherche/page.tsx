import type { Metadata } from "next";
import { headers } from "next/headers";

import { searchService } from "@/modules/search";
import { clampSearchQuery, resolveSearchConfig } from "@/modules/search/config";
import { listProductsByIds } from "@/storefront/lib/api/products";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { buildPageMetadata } from "@/lib/seo/page-metadata";
import { SearchView } from "@/storefront/components/storefront/search-view";
import { SearchTrack } from "@/app/(shop)/(tokyo)/recherche/search-track";

/**
 * Tokyo storefront search results — `/recherche?q=…`.
 *
 * The header search box (Enter / "Voir tous les résultats") lands here. Product
 * hits from the REAL backend search (`@/modules/search`: FTS + trigram, optional
 * semantic + alias expansion) are hydrated to storefront `Product` DTOs in score
 * order and rendered through the shared Normal V1 listing (`<SearchView>` →
 * `<ListingRegion>`), with the search box, an "Résultats pour « q »" hero, and
 * category scope tabs on top. Secondary (category/brand/blog) hits are omitted:
 * the mockup is products-only + scope tabs. Server-rendered.
 */

function readQuery(raw: string | string[] | undefined): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return clampSearchQuery(typeof v === "string" ? v : "");
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}): Promise<Metadata> {
  const q = readQuery((await searchParams).q);
  const base = await buildPageMetadata({
    title: q ? `Recherche : ${q}` : "Recherche",
    description: q
      ? `Résultats de recherche pour « ${q} » sur Tokyo Store.`
      : "Recherchez smartphones, casques, gaming et accessoires sur Tokyo Store.",
    path: "/recherche",
  });
  // Internal search pages are thin/duplicate content → noindex, but follow so
  // crawlers still reach the real product/category pages.
  return { ...base, robots: { index: false, follow: true } };
}

export default async function TokyoSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const q = readQuery((await searchParams).q);

  const settings = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  const cfg = resolveSearchConfig(settings);

  // Below the minimum query length (or empty): prompt, no search call.
  if (q.length < cfg.minQueryLength) {
    return (
      <SearchView
        key={q}
        query={q}
        products={[]}
        notice={`Tapez au moins ${cfg.minQueryLength} caractère${cfg.minQueryLength > 1 ? "s" : ""} pour lancer une recherche.`}
      />
    );
  }

  // This uncached RSC fans the query into the FTS/trigram readers + a search_log
  // write, so rate-limit the committed search per IP (fails OPEN on limiter
  // outage so the box keeps working). Same bucket shape as the autocomplete API.
  const ip = getClientIp(await headers()) || "anon";
  const pageRl = await checkRateLimit({ bucket: `search:page:${ip}`, max: 60, windowSeconds: 60 }).catch(
    () => ({ ok: true, count: 0, resetAt: 0 }),
  );
  if (!pageRl.ok) {
    return (
      <SearchView
        key={q}
        query={q}
        products={[]}
        notice="Vous avez lancé beaucoup de recherches. Patientez une minute, puis réessayez."
      />
    );
  }

  // Meter the SEMANTIC path separately (a paid embedding call); over the cap we
  // degrade to keyword-only recall rather than embedding.
  let semantic = cfg.semanticEnabled;
  if (semantic) {
    const rl = await checkRateLimit({ bucket: `search:sem:${ip}`, max: 30, windowSeconds: 60 }).catch(
      () => ({ ok: true, count: 0, resetAt: 0 }),
    );
    semantic = rl.ok;
  }

  const result = await searchService
    .search(q, { limit: cfg.resultLimit, config: cfg, semantic })
    .catch(() => null);

  // Hydrate product DTOs in score order (reuse the ranked ids — no second FTS
  // query); resolved LIVE from the backend (catalogSource → Postgres), which
  // preserves input order and drops any id no longer published.
  const ids = result?.products.map((p) => p.id) ?? [];
  const products = ids.length > 0 ? await listProductsByIds(ids).catch(() => []) : [];

  return (
    <>
      <SearchTrack term={q} results={result?.total ?? 0} />
      <SearchView key={q} query={q} products={products} />
    </>
  );
}
