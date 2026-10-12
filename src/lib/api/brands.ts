import "server-only";

import { brandQueries } from "@/modules/catalog/brand";
import { brandService } from "@/modules/catalog/brand/service";
import type { BrandRow } from "@/modules/catalog/brand/schema";
import { mediaQueries } from "@/modules/media";

/**
 * External-API brand shape — a flat projection carrying everything a headless /
 * ERP client needs to round-trip & reconcile: the uuid `id`, the `externalRef`,
 * SEO fields, and the media soft-links. Distinct from the storefront brand row.
 */
export type ApiBrand = {
  id: string;
  slug: string;
  name: string;
  externalRef: string | null;
  isActive: boolean;
  isDiscountable: boolean;
  displayOrder: number;
  description: string | null;
  tagline: string | null;
  logoMediaId: string | null;
  heroMediaId: string | null;
  ogImageMediaId: string | null;
  // Listing chip icon (curated lucide key + optional custom image).
  icon: string | null;
  iconMediaId: string | null;
  // Brand tier of the tax cascade (bps); the editorial block + value-prop cards.
  taxRateBps: number | null;
  editorialEyebrow: string | null;
  editorialTitle: string | null;
  editorialBody: string | null;
  valueProps: BrandRow["value_props"];
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
};

/** A reference an external caller can address a brand by (caller picks ONE). */
export type BrandRef = {
  brandId?: string | null;
  externalRef?: string | null;
  slug?: string | null;
};

function toApiBrand(row: BrandRow): ApiBrand {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    externalRef: row.external_ref ?? null,
    isActive: row.is_active,
    isDiscountable: row.is_discountable,
    displayOrder: row.display_order,
    description: row.description ?? null,
    tagline: row.tagline ?? null,
    logoMediaId: row.logo_media_id ?? null,
    heroMediaId: row.hero_media_id ?? null,
    ogImageMediaId: row.og_image_media_id ?? null,
    icon: row.icon ?? null,
    iconMediaId: row.icon_media_id ?? null,
    taxRateBps: row.tax_rate_bps ?? null,
    editorialEyebrow: row.editorial_eyebrow ?? null,
    editorialTitle: row.editorial_title ?? null,
    editorialBody: row.editorial_body ?? null,
    valueProps: row.value_props ?? null,
    metaTitle: row.meta_title ?? null,
    metaDescription: row.meta_description ?? null,
    canonicalUrl: row.canonical_url ?? null,
    noindex: row.noindex,
  };
}

/**
 * Resolve a single LIVE brand ROW by an EXPLICIT reference — the caller picks
 * the field; NOT a fallback chain. O(1) via the id / external_ref unique
 * indexes (slug is indexed too). Resolves regardless of `is_active` so a keyed
 * ERP caller can read/sync inactive brands.
 */
export async function resolveBrandRow(ref: BrandRef): Promise<BrandRow | null> {
  if (ref.brandId) return brandService.findById(ref.brandId);
  if (ref.externalRef) return brandService.findByExternalRef(ref.externalRef);
  if (ref.slug) return brandService.findBySlug(ref.slug);
  return null;
}

/**
 * Single-brand read for the external API, addressed by ANY reference.
 * `activeOnly` (the PUBLIC path) hides inactive/draft brands from anonymous
 * callers; a keyed ERP caller (activeOnly=false) sees drafts.
 */
export async function getApiBrandByRef(
  ref: BrandRef,
  opts: { activeOnly?: boolean } = {},
): Promise<ApiBrand | null> {
  const row = await resolveBrandRow(ref);
  if (!row) return null;
  if (opts.activeOnly && !row.is_active) return null;
  return toApiBrand(row);
}

/**
 * Brand list for the external API. `activeOnly` (the PUBLIC path) drops inactive
 * brands so the public list matches the storefront contract; keyed ERP callers
 * get the full set. Supports `search` (name) + `limit`/`offset`.
 */
export async function listApiBrands(
  opts: { search?: string; limit?: number; offset?: number; activeOnly?: boolean } = {},
): Promise<ApiBrand[]> {
  const rows = await brandService.list(opts);
  return rows.map(toApiBrand);
}

/** Storefront brand + resolved logo for the category-page "Marques" strip. */
export type NavBrand = { slug: string; name: string; logoUrl: string | null; logoAlt: string | null };

/**
 * Active brands with a resolved display image (médiathèque, ONE batched query;
 * logo → chip icon → null). Feeds the "Marques" strip under Explorer davantage
 * on category + subcategory pages. Empty when there are no active brands.
 */
export async function listNavBrands(): Promise<NavBrand[]> {
  const brands = await brandQueries.listActiveBrands().catch(() => []);
  if (brands.length === 0) return [];
  const imageIds = brands.flatMap((b) =>
    [b.logo_media_id, b.icon_media_id].filter((id): id is string => Boolean(id)),
  );
  const logoMap =
    imageIds.length > 0
      ? await mediaQueries.resolveUrlAltMap(imageIds).catch(() => new Map())
      : new Map();
  return brands.map((b) => {
    const logo =
      (b.logo_media_id ? logoMap.get(b.logo_media_id) : null) ??
      (b.icon_media_id ? logoMap.get(b.icon_media_id) : null) ??
      null;
    return { slug: b.slug, name: b.name, logoUrl: logo?.url ?? null, logoAlt: logo?.alt ?? null };
  });
}
