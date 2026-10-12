import "server-only";

import { cache } from "react";
import { cacheTag, cacheLife } from "next/cache";
import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { isBuildPhase } from "@/lib/cache/build-phase";
import { brands, type BrandRow } from "./schema";

// `cache()`-memoized per request: the product editor pages (new/edit/list) each
// load the full brand picker, and a single render can resolve it more than once
// (page + form). Without memoization that's a duplicate unbounded SELECT per
// render. No LIMIT — the picker needs the whole set for its in-field search.
export const listAllBrands = cache(async (): Promise<BrandRow[]> => {
  return db
    .select()
    .from(brands)
    .where(isNull(brands.deleted_at))
    .orderBy(asc(brands.display_order), asc(brands.name));
});

/**
 * Active, non-deleted brands — the storefront-visible set (brands index `/marques`,
 * the brand nav strip, every brand page). CROSS-REQUEST cached: brands change
 * rarely and the set is viewer-independent, so it's served from cache on every
 * visit and recomputed only when the `brands` tag is busted (instantly, by the
 * invalidate-catalog-cache subscriber on any brand write). `cacheLife("hours")`
 * is only the fallback ceiling — the tag bust is what keeps edits read-your-write.
 *
 * Build-phase guard: this is called from the shop LAYOUT (the nav strip), which is
 * rendered while statically prerendering pages at build — where there is no DB. A
 * `'use cache'` throw there is a fatal, uncatchable prerender error, so skip it and
 * return empty during the build (every shop page is dynamic at runtime, so the
 * empty is never served — see @/lib/cache/build-phase).
 */
export async function listActiveBrands(): Promise<BrandRow[]> {
  if (isBuildPhase()) return [];
  return listActiveBrandsCached();
}
async function listActiveBrandsCached(): Promise<BrandRow[]> {
  "use cache";
  cacheLife("hours");
  cacheTag(CACHE_TAGS.brands);
  return db
    .select()
    .from(brands)
    .where(and(eq(brands.is_active, true), isNull(brands.deleted_at)))
    .orderBy(asc(brands.display_order), asc(brands.name));
}

/**
 * Flat list of STOREFRONT-VISIBLE (active, non-deleted) brands for the sitemap —
 * slug + noindex + canonical override + real `updated_at` lastmod. CROSS-REQUEST
 * cached + tagged `brands` so it reuses the same warm cache the nav/listing reads
 * populate (the sitemap is force-dynamic; this avoids a cold full-table read). The
 * caller pairs the ids with the published-product count to drop empty brands and
 * honours the canonical override (mirrors listSitemapCategories).
 */
export async function listSitemapBrands(): Promise<
  Array<{ id: string; slug: string; noindex: boolean; canonical_url: string | null; updatedAt: Date }>
> {
  "use cache";
  cacheLife("hours");
  cacheTag(CACHE_TAGS.brands);
  const rows = await db
    .select({
      id: brands.id,
      slug: brands.slug,
      noindex: brands.noindex,
      canonical_url: brands.canonical_url,
      updatedAt: brands.updated_at,
    })
    .from(brands)
    .where(and(eq(brands.is_active, true), isNull(brands.deleted_at)))
    .orderBy(asc(brands.display_order), asc(brands.name));
  return rows;
}

// CROSS-REQUEST cached (`'use cache'`): the storefront /[slug] resolver calls this
// in BOTH generateMetadata and the page render, and across visitors the answer is
// the same per slug. Tagged `brands` so any brand write busts it instantly
// (read-your-writes); `cacheLife("hours")` is just the fallback ceiling.
export async function getBrandBySlug(slug: string): Promise<BrandRow | null> {
  "use cache";
  cacheLife("hours");
  cacheTag(CACHE_TAGS.brands);
  const [row] = await db
    .select()
    .from(brands)
    .where(and(eq(brands.slug, slug), isNull(brands.deleted_at)))
    .limit(1);
  return row ?? null;
}
