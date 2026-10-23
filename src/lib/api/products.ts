import "server-only";

import { mediaQueries, resolveMediaUrl, resolveMediaSocialUrl, resolveMediaAlt } from "@/modules/media";
import { getTopSellingProducts } from "@/modules/order/queries";
import { productQueries } from "@/modules/catalog/product";
import { productService } from "@/modules/catalog/product/service";
import { attributeQueries } from "@/modules/catalog/attribute";
import { categoryWarrantyFromChain, getDefaultWarranty, resolveWarranty } from "@/lib/warranty";
import { loadCategoryChains } from "@/lib/catalog/category-chain";
import { categoryQueries } from "@/modules/catalog/category";
import { categoryService } from "@/modules/catalog/category/service";
import { brandQueries } from "@/modules/catalog/brand";
import { brandService } from "@/modules/catalog/brand/service";
import { productMediaLink, productBrandLink } from "@/associations/catalog.service";
import {
  productCategoryLinks,
  productRelatedLinks,
  productComplementaryLinks,
} from "@/associations/catalog.service";
import type { Product, CategorySlug } from "@/types/catalog";
import { variantInStock } from "@/types/catalog";
import { parseSameAs } from "@/lib/seo/same-as";
import { getSharedStockDefault, isSharedStock } from "@/lib/inventory/variant-stock";
import type { ProductRow, ProductVariantRow } from "@/modules/catalog/product/schema";
import { showcaseService } from "@/modules/showcase";
import {
  promotionService,
  listNonDiscountableProductIds,
  effectiveScopeTargets,
  type PromotionRow,
} from "@/modules/promotion";
import { resolveProductDiscount } from "@/lib/promotions/product-discount";
import { isActivePreorder } from "@/lib/inventory/preorder";
import type { CollectionPageConfig } from "@/lib/pages/collection-page-config";
import { dinarsToMinor, minorToDinars } from "@/lib/price";
import { AUTH_POLICY } from "@/lib/auth/policy";
import { cache } from "react";
import { cacheTag, cacheLife } from "next/cache";

import { CACHE_TAGS, cacheTag as catTag } from "@/lib/cache/tags";
import { capGridIds } from "@/lib/catalog/grid-cap";
import { cardDealFraction, listingDisplayPricing } from "@/lib/listing/display-pricing";

/**
 * Storefront-facing product API — DB-backed.
 *
 * Returns the legacy `Product` shape so storefront pages stay untouched:
 * the only thing that changed is the source. Components consuming
 * `Product` work without modification.
 *
 * Notes on the mapping:
 *   - `price_cents` → `price` (TND, no decimals)
 *   - `image` is the primary product_media URL, fallback to a placeholder
 *   - `category` is the primary category's slug
 *   - `subcategory` is the deepest other category's slug (best-effort)
 */

/** Sentinel the mapper falls back to for an imageless product. Exported so feed
 *  builders can treat it as "no image" (Google rejects placeholder/SVG images). */
export const PLACEHOLDER_IMAGE = "/placeholder.svg";

/**
 * Public DTO + raw row for a slug, returning DRAFTS too (the /[slug] resolver
 * feeds this to renderProductView, which re-applies the admin-only DRAFT gate
 * — 404 for the public, "Mode aperçu" for admins; filtering drafts here would
 * make admin preview unreachable).
 *
 * CROSS-REQUEST cached (`'use cache'`): the PDP fired mapProductRows' ~7-10 queries
 * on every visit (generateMetadata + the page render, force-dynamic). The result
 * is the BASE product DTO only — promotions and session/quick-buy prefill are
 * applied LATER in renderProductView.
 * Tagged per-product so a stock change (admin edit, restock, OR a SALE —
 * place-order now emits product.updated) busts it instantly; `cacheLife("hours")`
 * is the fallback ceiling.
 */
export async function getProductWithRowBySlug(slug: string): Promise<{
  product: Product;
  row: NonNullable<Awaited<ReturnType<typeof productQueries.getProductBySlug>>>;
} | null> {
  "use cache";
  cacheLife("hours");
  // Tag dependencies = every entity whose data mapProductRows bakes into the DTO,
  // so a write to ANY of them refreshes the cached PDP (the read declares its
  // deps rather than each writer remembering to bust the product tags):
  //   • product itself → product:<id> (added below) + product:slug:<slug> +
  //     products:list (product save / stock change / review writes bust these)
  //   • brand        → `brands`     (a brand rename/slug change is embedded as
  //                                  product.brand / brandSlug)
  //   • category     → `categories` (the product's primary category name/slug)
  //   • attribute    → `products`   (variant axis labels; the attribute subscriber
  //                                  busts the broad `products` tag)
  cacheTag(
    CACHE_TAGS.productsList,
    CACHE_TAGS.products,
    CACHE_TAGS.brands,
    CACHE_TAGS.categories,
    catTag.productSlug(slug),
  );
  const row = await productQueries.getProductBySlug(slug);
  if (!row) return null;
  cacheTag(catTag.product(row.id));
  const [mapped] = await mapProductRows([row]);
  if (!mapped) return null;
  return { product: mapped, row };
}

/** Public product DTO by slug — drafts excluded (metadata/listings must never
 *  leak an unpublished product). Delegates to the cached resolver so it shares
 *  the same per-request enrichment as the page body. NOTE: applies NO live promo
 *  — a surface that renders the product's content applies that itself (the PDP
 *  body and the /md twin use `getProductWithRowBySlug`). */
export async function getProductBySlug(slug: string): Promise<Product | null> {
  const pair = await getProductWithRowBySlug(slug);
  if (!pair || !pair.row.is_published) return null;
  return pair.product;
}

export async function listProductsByCategory(category: string, limit?: number): Promise<Product[]> {
  const cat = await categoryQueries.getCategoryBySlug(category);
  if (!cat) return [];
  // Roll up descendants so a PARENT category surfaces products filed on its
  // leaves (matches the admin list + the mega-menu nav counts). A leaf rolls
  // up to just itself, so leaf pages are unchanged.
  //
  // Returns the FULL set on purpose — the storefront category page needs every
  // product for faceted attribute filtering + client-side sort/pagination.
  // For a single PAGE (the external API), use `listApiProductsByCategory`.
  const ids = await productCategoryLinks.listProductIdsInCategoryTree(cat.id);
  return productsForIds(ids, limit);
}

// ─────────────────────────────────── External API (ERP) reads + reference
/**
 * The external-API product shape: the storefront `Product` DTO PLUS the fields a
 * headless / ERP client needs to round-trip and reconcile — the uuid `id`, the
 * `externalRef`, the numeric `stockQty`, and the per-product purchase-qty limits
 * (`minPurchaseQty` / `maxPurchaseQty`, both null = no limit). (sku / gtin / mpn
 * are already on `Product`.) Built from the raw row so the storefront contract
 * is untouched.
 *
 * PRICE CONTRACT: every API read (list AND by-ref) returns the same EFFECTIVE
 * `priceCents` / `oldPriceCents` (+ per-variant prices) with live auto
 * promotions folded in — the price a shopper pays right now. `basePriceCents` /
 * `baseOldPriceCents` are the STORED product-row values (what POST/PUT/PATCH
 * `priceCents` / `oldPriceCents` write), so an ERP compares / round-trips those,
 * never the promo-lowered `priceCents`.
 */
export type ApiProduct = Product & {
  id: string;
  externalRef: string | null;
  stockQty: number | null;
  minPurchaseQty: number | null;
  maxPurchaseQty: number | null;
  basePriceCents: number;
  baseOldPriceCents: number | null;
};

/** A reference an external caller can address a product by (caller picks ONE). */
export type ProductRef = {
  productId?: string | null;
  externalRef?: string | null;
  sku?: string | null;
  gtin?: string | null;
  slug?: string | null;
};

function toApiProduct(
  p: Product,
  row: ProductRow,
  opts?: { stripInternal?: boolean },
): ApiProduct {
  return {
    ...p,
    id: row.id,
    // externalRef is the merchant's INTERNAL ERP/PIM keying scheme — never
    // exposed by the storefront DTO. Strip it for anonymous PUBLIC callers (a
    // headless frontend has no use for it); keyed ERP callers still round-trip it.
    externalRef: opts?.stripInternal ? null : (row.external_ref ?? null),
    stockQty: row.stock_qty ?? null,
    minPurchaseQty: row.min_purchase_qty ?? null,
    maxPurchaseQty: row.max_purchase_qty ?? null,
    basePriceCents: row.price_cents,
    baseOldPriceCents: row.old_price_cents ?? null,
  };
}

/**
 * Resolve a single LIVE product ROW by an EXPLICIT reference — the caller picks
 * the field; this is NOT a fallback chain (a present-but-unmatched key returns
 * null rather than trying the next). Precedence only disambiguates if a caller
 * sends several. O(1) per lookup via the partial unique indexes.
 */
export async function resolveProductRow(ref: ProductRef): Promise<ProductRow | null> {
  if (ref.productId) return productService.findById(ref.productId);
  if (ref.externalRef) return productService.findByExternalRef(ref.externalRef);
  if (ref.sku) return productService.findBySku(ref.sku);
  if (ref.gtin) return productService.findByGtin(ref.gtin);
  if (ref.slug) return productService.findBySlug(ref.slug);
  return null;
}

/**
 * Single-product read for the external API, addressed by ANY reference. Returns
 * the {@link ApiProduct} or null. `includeUnpublished` lets a TRUSTED keyed
 * caller read drafts (so create-then-verify works); public callers pass false.
 * Mapped through the SAME live-promo enrichment as the list reads, so one
 * product never shows two prices across `?sku=` / `/[slug]` and the list (the
 * stored price stays available as `basePriceCents` for create-then-verify).
 */
export async function getApiProductByRef(
  ref: ProductRef,
  opts: { includeUnpublished?: boolean; public?: boolean } = {},
): Promise<ApiProduct | null> {
  const row = await resolveProductRow(ref);
  if (!row) return null;
  if (!opts.includeUnpublished && !row.is_published) return null;
  const [mapped] = await mapAndEnrichRows([row]);
  return mapped ? toApiProduct(mapped, row, { stripInternal: opts.public }) : null;
}

/**
 * One external-API product PAGE plus `rawCount` — the size of the underlying DB
 * page (== `products.length`). Clients page by `offset += rawCount` and stop only
 * when `rawCount < limit` — never on `products.length`.
 */
export type ApiProductPage = { products: ApiProduct[]; rawCount: number };

// Better Auth's session cookie: `<cookiePrefix>.session_token`, `__Secure-`
// prefixed over HTTPS (the prefix is a plain identifier — no regex escaping).
const SESSION_COOKIE_RE = new RegExp(`(?:^|;\\s*)(?:__Secure-)?${AUTH_POLICY.cookiePrefix}\\.session_token=[^;\\s]`);

/**
 * Cache-Control for a PUBLIC (keyless) product read. A request carrying a session
 * cookie may receive a per-viewer body, so it's marked private and never stored by
 * a shared cache; an anonymous request is shared-cacheable for `sMaxAge`. `Vary:
 * Cookie` on both, so a cache keeps the two apart.
 */
export function publicProductReadHeaders(request: Request, sMaxAge = 60): Record<string, string> {
  const cookie = request.headers.get("cookie");
  if (cookie && SESSION_COOKIE_RE.test(cookie)) return { "Cache-Control": "private, no-store", Vary: "Cookie" };
  return { "Cache-Control": `public, s-maxage=${sMaxAge}, stale-while-revalidate=300`, Vary: "Cookie" };
}

/** Paginated published list for the external API — ApiProduct (id/stock/externalRef) + rawCount. */
export async function listApiProductsPage(
  opts: { limit?: number; offset?: number; public?: boolean } = {},
): Promise<ApiProductPage> {
  const rows = await productQueries.listPublishedProducts({
    limit: opts.limit ?? 24,
    offset: opts.offset ?? 0,
  });
  const products = await mapAndEnrichRows(rows);
  // mapAndEnrichRows preserves input order and length, so products[i] ↔ rows[i].
  return {
    products: products.map((p, i) => toApiProduct(p, rows[i], { stripInternal: opts.public })),
    rawCount: rows.length,
  };
}

/** Paginated published list for the external API — ApiProduct (id/stock/externalRef). */
export async function listApiProducts(
  opts: { limit?: number; offset?: number; public?: boolean } = {},
): Promise<ApiProduct[]> {
  return (await listApiProductsPage(opts)).products;
}

/**
 * One PUBLIC-only page for the product FEEDS (Google Merchant / ACP). Publishes
 * the public catalogue (published products). `rawCount` (the size of the
 * underlying DB page) lets the caller paginate correctly.
 */
export async function listPublicFeedProductsPage(opts: {
  limit: number;
  offset: number;
}): Promise<{ products: ApiProduct[]; rawCount: number }> {
  const rows = await productQueries.listPublishedProducts({ limit: opts.limit, offset: opts.offset });
  const products = await mapAndEnrichRows(rows);
  return { products: products.map((p, i) => toApiProduct(p, rows[i])), rawCount: rows.length };
}

/** DB-paginated category listing for the external API — ApiProduct, newest-first,
 *  + `rawCount` (the DB page size before the public filter, see {@link ApiProductPage}). */
export async function listApiProductsByCategoryPage(
  category: string,
  opts: { limit?: number; offset?: number; public?: boolean } = {},
): Promise<ApiProductPage> {
  const cat = await categoryQueries.getCategoryBySlug(category);
  if (!cat) return { products: [], rawCount: 0 };
  const pageIds = await productCategoryLinks.listPublishedProductIdsInCategoryTreePaged(cat.id, {
    limit: opts.limit ?? 24,
    offset: opts.offset ?? 0,
  });
  if (pageIds.length === 0) return { products: [], rawCount: 0 };
  const rows = await productQueries.listProductsByIds(pageIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = pageIds.map((id) => byId.get(id)).filter((r): r is ProductRow => Boolean(r));
  const products = await mapAndEnrichRows(ordered);
  return {
    products: products.map((p, i) => toApiProduct(p, ordered[i], { stripInternal: opts.public })),
    rawCount: pageIds.length,
  };
}

/** DB-paginated category listing for the external API — ApiProduct, newest-first. */
export async function listApiProductsByCategory(
  category: string,
  opts: { limit?: number; offset?: number; public?: boolean } = {},
): Promise<ApiProduct[]> {
  return (await listApiProductsByCategoryPage(category, opts)).products;
}

export async function listProductsBySubcategory(
  category: string,
  subcategory: string,
): Promise<Product[]> {
  const sub = await categoryQueries.getSubcategoryBySlug(category, subcategory);
  if (!sub) return [];
  // Mid-tree subcategories can have children of their own — roll those up too.
  const ids = await productCategoryLinks.listProductIdsInCategoryTree(sub.id);
  return productsForIds(ids);
}

export async function listProductsByBrand(brandSlug: string, limit?: number): Promise<Product[]> {
  const brand = await brandQueries.getBrandBySlug(brandSlug);
  // Fail CLOSED on a deactivated brand: the brand storefront page 404s when
  // !is_active, so a home brand-rail that still listed its products would dangle a
  // « Voir tout » at a 404 and surface a brand the operator took offline.
  if (!brand || !brand.is_active) return [];
  const ids = await productBrandLink.listProductIdsForBrand(brand.id);
  return productsForIds(ids, limit);
}

/** DB-paginated brand listing — ApiProduct, newest-first. Mirrors
 *  {@link listApiProductsByCategory} so callers that only need a bounded PAGE
 *  (markdown twins, headless feeds) never enrich the whole brand catalogue.
 *  `public` strips internal fields, exactly like the category listing — every
 *  anonymous surface (the /md brand twin) passes it. */
export async function listApiProductsByBrand(
  brandSlug: string,
  opts: { limit?: number; offset?: number; public?: boolean } = {},
): Promise<ApiProduct[]> {
  const brand = await brandQueries.getBrandBySlug(brandSlug);
  if (!brand) return [];
  const pageIds = await productBrandLink.listPublishedProductIdsForBrandPaged(brand.id, {
    limit: opts.limit ?? 24,
    offset: opts.offset ?? 0,
  });
  if (pageIds.length === 0) return [];
  const rows = await productQueries.listProductsByIds(pageIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = pageIds.map((id) => byId.get(id)).filter((r): r is ProductRow => Boolean(r));
  const products = await mapAndEnrichRows(ordered);
  return products.map((p, i) => toApiProduct(p, ordered[i], { stripInternal: opts.public }));
}

/** Up to this many curated (manual/ai) products are shown — a bit more than
 *  the derived modes, since the admin hand-picked them. */
const CURATED_RELATED_LIMIT = 8;

/**
 * The storefront "Vous aimerez aussi" rail. Branches on the product's
 * `related_mode`:
 *   - auto (default) — derived heuristic (category siblings → brand → recent)
 *   - same_subcategory / same_brand / mixed — random draw from the matching pool
 *   - manual / ai — the curated `product_related` list (in display order),
 *     falling back to auto if it resolves to nothing publishable.
 */
export async function listRelatedProducts(slug: string, limit = 4): Promise<Product[]> {
  const seed = await productQueries.getProductBySlug(slug);
  if (!seed) return [];

  const mode = seed.related_mode ?? "auto";

  if (mode === "manual" || mode === "ai") {
    const ids = await productRelatedLinks.listForProduct(seed.id);
    // Order-preserving + published-only; honour the caller's limit (capped at the
    // curated max) so manual/ai rails match the 4-wide grid like the derived modes.
    const curated = (await listProductsByIds(ids)).slice(0, Math.min(limit, CURATED_RELATED_LIMIT));
    // Never show an empty rail — if every curated pick is unpublished/deleted,
    // fall back to the derived heuristic.
    return curated.length > 0 ? curated : deriveAutoRelated(seed, limit);
  }
  if (mode === "same_subcategory") return deriveSiblingRelated(seed, limit, "category");
  if (mode === "same_brand") return deriveSiblingRelated(seed, limit, "brand");
  if (mode === "mixed") return deriveSiblingRelated(seed, limit, "mixed");
  return deriveAutoRelated(seed, limit);
}

/**
 * "Accessoires supplémentaires" — the curated MANUAL complementary list. Unlike
 * related products there is no auto/AI fallback: an empty curated set renders no
 * section (the admin opts a product in by picking accessories). Published-only,
 * display-order preserved, resolved to the same Product DTO the cards consume.
 */
export async function listComplementaryProducts(slug: string, limit = 4): Promise<Product[]> {
  const seed = await productQueries.getProductBySlug(slug);
  if (!seed) return [];
  const ids = await productComplementaryLinks.listForProduct(seed.id);
  if (ids.length === 0) return [];
  return (await listProductsByIds(ids)).slice(0, limit);
}

/** Fisher-Yates shuffle (server-side, so Math.random is fine). */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Random products from the same primary category and/or brand. `source`
 * selects the candidate pool; the pool is shuffled (so the rail rotates) then
 * filtered to published + capped.
 */
async function deriveSiblingRelated(
  seed: ProductRow,
  limit: number,
  source: "category" | "brand" | "mixed",
): Promise<Product[]> {
  const ids = new Set<string>();

  if (source === "category" || source === "mixed") {
    const linkRows = await productCategoryLinks.listForProduct(seed.id);
    const primary = linkRows.find((r) => r.is_primary);
    // Prefer the single primary (leaf) category; else fan out over all links.
    const catIds = primary ? [primary.category_id] : linkRows.map((r) => r.category_id);
    const perCategory = await Promise.all(
      catIds.map((c) => productCategoryLinks.listProductIdsInCategory(c)),
    );
    for (const arr of perCategory) for (const id of arr) if (id !== seed.id) ids.add(id);
  }

  if (source === "brand" || source === "mixed") {
    const brandId = await productBrandLink.findBrandId(seed.id);
    if (brandId) {
      const brandIds = await productBrandLink.listProductIdsForBrand(brandId);
      for (const id of brandIds) if (id !== seed.id) ids.add(id);
    }
  }

  // The candidate pool comes from RAW link tables (no is_published / deleted_at
  // filter), so cap GENEROUSLY before resolving but filter to published FIRST
  // (productsForIds drops unpublished/deleted) — capping a tiny window before
  // the filter could leave the rail short when stale/draft links dominate.
  const candidates = shuffle([...ids]).slice(0, limit * 8);
  const products = await productsForIds(candidates);
  const picked = products.slice(0, limit);

  // Respect the mode's intent: show up to `limit` matching siblings — fewer is
  // fine when the pool genuinely has fewer (don't pad with unrelated products).
  // Only fall back to the derived heuristic when there are ZERO publishable
  // siblings, so the rail is never completely empty (mirrors the manual/ai
  // branch's no-empty-rail guarantee).
  if (picked.length === 0) return deriveAutoRelated(seed, limit);
  return picked;
}

/** The derived heuristic rail (category siblings → same brand → most recent). */
async function deriveAutoRelated(seed: ProductRow, limit: number): Promise<Product[]> {
  // Pull EVERY category link for the product, not just the one flagged
  // `is_primary`. The previous implementation bailed out (empty array) when
  // a product was saved without explicitly marking a primary category —
  // which the workflows allow (`primaryCategoryId` is optional). Falling
  // back to the full link set means siblings still surface for those rows.
  const linkRows = await productCategoryLinks.listForProduct(seed.id);
  const primary = linkRows.find((r) => r.is_primary);
  const orderedCatIds = [
    ...(primary ? [primary.category_id] : []),
    ...linkRows
      .filter((r) => !r.is_primary)
      .map((r) => r.category_id),
  ];

  // Gather candidate sibling IDs across all of the seed's categories,
  // preserving the primary-first ordering and de-duping. We over-fetch then
  // re-filter against `is_published` in `productsForIds`, so request a few
  // extra here to give the fallback chain room to recover from unpublished
  // siblings without going back to the DB.
  const seen = new Set<string>([seed.id]);
  const candidateIds: string[] = [];
  // Fetch every category's product ids in parallel (was a per-category await
  // waterfall), then merge in category order, de-duping + capping at limit*3.
  const perCategory = await Promise.all(
    orderedCatIds.map((catId) => productCategoryLinks.listProductIdsInCategory(catId)),
  );
  for (const ids of perCategory) {
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      candidateIds.push(id);
    }
    if (candidateIds.length >= limit * 3) break;
  }

  let related = await productsForIds(candidateIds);
  related = related.slice(0, limit);

  // Fallback 1 — same brand. Useful when a product is the sole publishable
  // entry in its category but the brand has neighbouring SKUs.
  if (related.length < limit) {
    const brandId = await productBrandLink.findBrandId(seed.id);
    if (brandId) {
      const brandIds = await productBrandLink.listProductIdsForBrand(brandId);
      const fillIds = brandIds.filter((id) => !seen.has(id));
      const brandFill = await productsForIds(fillIds);
      for (const p of brandFill) {
        if (related.some((r) => r.slug === p.slug)) continue;
        related.push(p);
        if (related.length >= limit) break;
      }
    }
  }

  // Fallback 2 — most recently published. Last-ditch top-up so a freshly
  // seeded category with a single product still shows a sensible rail.
  if (related.length < limit) {
    const recent = await productQueries.listPublishedProducts({ limit: limit * 2 });
    const fillIds = recent.map((r) => r.id).filter((id) => !seen.has(id));
    const recentFill = await productsForIds(fillIds);
    for (const p of recentFill) {
      if (related.some((r) => r.slug === p.slug)) continue;
      related.push(p);
      if (related.length >= limit) break;
    }
  }

  return related;
}

export async function listNewArrivals(limit = 4): Promise<Product[]> {
  // For now: newest published. When merchandising rules graduate to their
  // own admin surface, add a `featured_on_home` boolean (or a richer
  // `homepage_slots` table) and filter on it here.
  const rows = await productQueries.listPublishedProducts({ limit });
  return mapAndEnrichRows(rows);
}

export async function listPromotions(limit = 4): Promise<Product[]> {
  // A product is "on promotion" if it has a merchandiser compare-at (the CARD's
  // old > new — cheapest variant for a variable product) OR a live engine AUTO
  // promotion touches it — so pure-engine promos surface here too, not just
  // compare-at products. The pool spans the WHOLE catalogue (it used to be the
  // newest-100 slice, so an older marked-down or promoted product never reached
  // the home rail); the rail keeps its newest-first order.
  const promoMap = await livePromoMap();
  const pool = await loadPromotionPool({
    promoMap,
    wantEngine: true,
    wantCompare: true,
    compareOrder: "recent",
  });
  const rows = pool.map((c) => c.row).sort(compareRowsNewest);
  const picked = rows.slice(0, limit);
  const products = await mapProductRows(picked);
  enrichWithLivePromos(products, picked, promoMap);
  return products;
}

// ─────────────────────────────────────────── Showcase collection pages

/** Map value: ALL live AUTO promotions that match a product, ordered by
 *  display_priority desc. Cards/search/feeds run these through the SAME
 *  `resolveProductDiscount` the PDP/cart/checkout use, so a product touched by
 *  ≥2 stackable auto-promos shows the COMPOUNDED price (not just the top one) and
 *  the per-promo max_discount_cents caps are honoured identically — otherwise a
 *  card/feed price disagrees with the PDP landing price (Merchant disapproval). */
type LivePromoDiscount = PromotionRow[];

/**
 * Map of productId → the live AUTO promotions matching it. Expands
 * product/category/brand-scoped promotions into concrete product ids
 * (cart-scope promos are skipped — no specific products). ALL matches are kept
 * (ordered by display_priority desc) so the discount resolver can compound
 * stackable promos exactly like the cart/PDP.
 */
async function buildLivePromotionDiscountMap(): Promise<Map<string, LivePromoDiscount>> {
  const promos = await promotionService.listLiveAutoPromotions().catch(() => []);
  // Uniform product-set targets per promo — its promotion_scope_targets rows (a
  // MULTI-target promo, scope='targeted') OR a synthesised legacy single-scope
  // target. Cart / target-less promos carry no specific products.
  const scopeTargetsByPromo = await promotionService
    .listScopeTargetsForPromotions(promos.map((p) => p.id))
    .catch(() => new Map());
  // Expand each promo's EFFECTIVE targets to product ids in PARALLEL. A CASCADING
  // category target rolls up its whole SUBTREE (listProductIdsInCategoryTree) so a
  // card shows the discount on a product filed only on a deep child — matching the
  // PDP/cart auto path, which cascades via ancestor expansion (was direct-only here,
  // a latent card-vs-PDP gap; now aligned). A direct-only category target (rare —
  // include_descendants=false) stays on the direct links.
  const expanded = await Promise.all(
    promos.map(async (promo) => {
      const eff = effectiveScopeTargets(promo, scopeTargetsByPromo.get(promo.id));
      const idSets = await Promise.all(
        eff.map((t) => {
          // Per-variant targets (migration 0173) are EXCLUDED from the product-level
          // card/feed map: it can't price a single variant, so advertising a
          // variant-only promo product-wide would over-advertise (a Merchant/ACP
          // feed-vs-landing mismatch). Under-display is safe — the PDP/cart/checkout
          // still apply it on the right variant.
          if (t.type === "product") return Promise.resolve(t.variantId == null ? [t.id] : []);
          if (t.type === "brand") return productBrandLink.listProductIdsForBrand(t.id).catch(() => []);
          return (
            t.cascade
              ? productCategoryLinks.listProductIdsInCategoryTree(t.id)
              : productCategoryLinks.listProductIdsInCategory(t.id)
          ).catch(() => []);
        }),
      );
      const ids = [...new Set(idSets.flat())];
      return { promo, ids };
    }),
  );
  const map = new Map<string, LivePromoDiscount>();
  // Accumulate ALL matches per product so stackable promos compound at render.
  for (const { promo, ids } of expanded) {
    for (const id of ids) {
      const arr = map.get(id);
      if (arr) arr.push(promo);
      else map.set(id, [promo]);
    }
  }
  // Sort each product's promos to the SAME tiebreak the CHARGE path uses
  // (display_priority DESC, created_at ASC) — resolveProductDiscount is head-wins
  // for non-stackable and folds stackables in array order, so an equal-priority
  // pair must be ordered identically here and at checkout or a card/feed price
  // diverges from the PDP/charged price. listLiveAutoPromotions returns
  // created_at DESC; this realigns to promotion/queries.ts:143-144.
  for (const arr of map.values()) {
    arr.sort(
      (a, b) => b.display_priority - a.display_priority || a.created_at.getTime() - b.created_at.getTime(),
    );
  }
  // Re-apply the global "never discountable" guard. This bulk map expands promo
  // SCOPES straight to product ids, bypassing getActiveDiscountForProduct — so a
  // flagged product (or one in a flagged category) would otherwise show a promo
  // price on its card while checkout charges full price. Strip them here.
  const blocked = await listNonDiscountableProductIds([...map.keys()]).catch(() => []);
  for (const id of blocked) map.delete(id);
  return map;
}

function discountedCents(priceCents: number, promos: LivePromoDiscount): number {
  // Mirror the cart/PDP/checkout engine EXACTLY by delegating to the SAME
  // resolver: it compounds stackable auto-promos and picks the best of the
  // non-stackable ones, applying each promo's max_discount_cents cap — so a
  // card/search/feed price never differs by a cent (or a whole stacked promo)
  // from what checkout actually charges.
  return resolveProductDiscount(priceCents, promos)?.effectivePriceCents ?? priceCents;
}

/**
 * Per-request-memoized live promo map. The home page builds it for several
 * rails (new arrivals / promotions); `cache()` collapses those into one
 * computation per RSC render. Falls back to an empty map on any error.
 */
const livePromoMap = cache(
  async (): Promise<Map<string, LivePromoDiscount>> =>
    buildLivePromotionDiscountMap().catch(() => new Map<string, LivePromoDiscount>()),
);

/**
 * Apply the live-engine discount to mapped products IN PLACE. `rows` aligns by
 * slug so each product's id can be looked up in `promoMap`; when the effective
 * price is lower we set price/oldPrice + their *_cents, using the original
 * price as the struck-through reference (or the existing higher compare-at).
 * Mirrors the PDP/cart rule so listing CARDS show the same effective price.
 */
function enrichWithLivePromos(
  products: Product[],
  rows: ProductRow[],
  promoMap: Map<string, LivePromoDiscount>,
): void {
  if (promoMap.size === 0) return;
  const rowBySlug = new Map(rows.map((r) => [r.slug, r]));
  for (const p of products) {
    const row = rowBySlug.get(p.slug);
    const promo = row ? promoMap.get(row.id) : undefined;
    if (!promo) continue;
    const orig = p.priceCents ?? dinarsToMinor(p.price);
    const disc = discountedCents(orig, promo);
    if (disc < orig) {
      const oldCents = p.oldPriceCents && p.oldPriceCents > orig ? p.oldPriceCents : orig;
      p.oldPriceCents = oldCents;
      p.priceCents = disc;
      p.price = minorToDinars(disc);
      p.oldPrice = minorToDinars(oldCents);
    }
    // Also fold the same live promo into each PER-VARIANT price. The product
    // feeds (Google Merchant / ACP) emit one row per variant off the raw
    // variant price, and the PDP + cart charge the discounted per-variant price
    // — so without this a variable product on a live AUTO promo would advertise
    // the FULL variant price in the feed (a feed-vs-landing-page mismatch that
    // trips Merchant Center). Mirrors the PDP variable branch's per-variant
    // resolveProductDiscount. (Merchandiser compare-at already rides on the
    // variant; this handles the engine promo the headline-only path missed.)
    for (const v of p.variants ?? []) {
      const vDisc = discountedCents(v.priceCents, promo);
      if (vDisc < v.priceCents) {
        v.oldPriceCents =
          v.oldPriceCents && v.oldPriceCents > v.priceCents ? v.oldPriceCents : v.priceCents;
        v.priceCents = vDisc;
      }
    }
  }
}

/**
 * Apply the live-engine discount to product SEARCH hits IN PLACE, using the
 * SAME live-promo map the listing cards use — so a product on a live auto
 * promotion shows the identical effective price in search as on the PDP/cart
 * (search reads raw `price_cents` straight from the table, which otherwise
 * showed the full, un-discounted price). Sets the effective `price_cents` and a
 * struck-through `old_price_cents`. Best-effort: `livePromoMap` already swallows
 * its own errors to an empty map, so this never breaks the search box.
 */
export async function enrichProductSearchHits(
  hits: Array<{ id: string; price_cents: number; old_price_cents: number | null }>,
): Promise<void> {
  if (hits.length === 0) return;
  const promoMap = await livePromoMap();
  if (promoMap.size === 0) return;
  for (const h of hits) {
    const promo = promoMap.get(h.id);
    if (!promo) continue;
    const orig = h.price_cents;
    const disc = discountedCents(orig, promo);
    if (disc < orig) {
      h.old_price_cents = h.old_price_cents && h.old_price_cents > orig ? h.old_price_cents : orig;
      h.price_cents = disc;
    }
  }
}

/**
 * Map rows → `Product` AND enrich with the live promotion engine. Use this for
 * every storefront LISTING surface (cards) so they reflect the same effective
 * discount the PDP/cart charge. NOTE: the PDP itself (getProductBySlug → bare
 * mapProductRows) applies its own richer multi-rule enrichment, so it must NOT
 * go through here — that would double-discount. (The /md product twin reuses
 * that single-product resolution via lib/promotions/live-product-price.ts.)
 */
async function mapAndEnrichRows(rows: ProductRow[]): Promise<Product[]> {
  const [products, promoMap] = await Promise.all([mapProductRows(rows), livePromoMap()]);
  enrichWithLivePromos(products, rows, promoMap);
  return products;
}

/**
 * Bound on each promotion pool fetch (engine ids / compare-at SQL rows). A broad
 * category/brand-scoped live promo can mark many products, but the results are
 * sliced to a page anyway — a generous constant keeps one wide promo from
 * fetching + sorting the entire catalogue. Well above any realistic
 * simultaneous-promo count at this store's scale.
 */
const PROMO_POOL_CAP = 300;

/** Listing order: published_at DESC NULLS LAST, then id DESC (uuid v7 ⇒ time-ordered). */
function compareRowsNewest(a: ProductRow, b: ProductRow): number {
  const pa = a.published_at?.getTime() ?? null;
  const pb = b.published_at?.getTime() ?? null;
  if (pa !== pb) {
    if (pa === null) return 1;
    if (pb === null) return -1;
    return pb - pa;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The « on promotion » candidate pool shared by the /promotions showcase and the
 * home promotions rail — published only, `exclude`d ids dropped, de-duped:
 *   - ENGINE: every product a live AUTO promotion touches (fetched by id);
 *   - COMPARE-AT: the products whose CARD shows a markdown — selected IN SQL
 *     over the whole catalogue (`listPublishedCompareAtProducts`), by deal or
 *     recency (`compareOrder`), instead of filtering a newest-100 slice.
 * Each candidate carries its card deal strength ({@link cardDealFraction}),
 * computed on the SAME display pricing the card uses — the cheapest variant's
 * price/compare-at for a variable product (one batched variant load), with the
 * live promo folded in — so a product qualifies (and ranks) exactly as its card
 * reads. The compare-at test is re-applied here on that pricing, so the SQL is
 * only the candidate selector. Unordered: each caller sorts.
 */
async function loadPromotionPool(opts: {
  promoMap: Map<string, LivePromoDiscount>;
  wantEngine: boolean;
  wantCompare: boolean;
  exclude?: Set<string>;
  compareOrder: "deal" | "recent";
}): Promise<Array<{ row: ProductRow; deal: number }>> {
  const { promoMap, wantEngine, wantCompare, exclude } = opts;
  const [engineRows, compareRows] = await Promise.all([
    wantEngine && promoMap.size > 0
      ? productQueries.listProductsByIds([...promoMap.keys()].slice(0, PROMO_POOL_CAP))
      : Promise.resolve([] as ProductRow[]),
    wantCompare
      ? productQueries.listPublishedCompareAtProducts({
          limit: PROMO_POOL_CAP,
          order: opts.compareOrder,
        })
      : Promise.resolve([] as ProductRow[]),
  ]);
  // Engine rows come from listProductsByIds (no published filter) → re-apply it.
  const byId = new Map<string, ProductRow>();
  for (const r of [...engineRows, ...compareRows]) {
    if (!r.is_published || exclude?.has(r.id) || byId.has(r.id)) continue;
    byId.set(r.id, r);
  }
  const candidates = [...byId.values()];
  const variableIds = candidates.filter((r) => r.product_type === "variable").map((r) => r.id);
  const variantsByProduct =
    variableIds.length > 0
      ? await productQueries.listVariantsForProducts(variableIds)
      : new Map<string, ProductVariantRow[]>();
  const out: Array<{ row: ProductRow; deal: number }> = [];
  for (const row of candidates) {
    const display = listingDisplayPricing(
      row,
      (variantsByProduct.get(row.id) ?? []).map((v) => ({
        priceCents: v.price_cents,
        oldPriceCents: v.old_price_cents,
      })),
    );
    const promo = promoMap.get(row.id);
    const engineHit = wantEngine && promo !== undefined;
    const compareHit = wantCompare && display.oldPriceCents != null;
    if (!engineHit && !compareHit) continue;
    const effective = promo ? discountedCents(display.priceCents, promo) : display.priceCents;
    out.push({ row, deal: cardDealFraction(display, effective) });
  }
  return out;
}

/**
 * Products for a showcase collection page (Nouveautés / Top ventes /
 * Promotions). Manually-pinned products render first (in pin
 * order), then the rules-based auto selection for the page's strategy. Prices
 * are enriched from the live promotion ENGINE so cards show the same effective
 * discount the PDP/cart would charge (fixes the old compare-at-only blind spot).
 */
export async function listShowcaseProducts(config: CollectionPageConfig): Promise<Product[]> {
  const limit = Math.min(config.limit || 24, 100);
  const pinnedIds = await showcaseService.listPinnedProductIds(config.slug).catch(() => []);
  const pinnedSet = new Set(pinnedIds);
  const promoMap = await livePromoMap();

  let autoRows: ProductRow[] = [];

  // Over-fetch the auto pool so the pinned-exclusion + the best-sellers unpublished
  // drop still leave ~`limit` candidates after filtering.
  const autoFetch = limit * 3 + pinnedIds.length;

  if (config.strategy === "new_arrivals") {
    const rows = await productQueries.listPublishedProducts({ limit: autoFetch });
    autoRows = rows.filter((r) => !pinnedSet.has(r.id));
  } else if (config.strategy === "best_sellers") {
    const top = await getTopSellingProducts(autoFetch, config.windowDays).catch(() => []);
    if (top.length > 0) {
      const rows = await productQueries.listProductsByIds(top.map((t) => t.productId));
      const rank = new Map(top.map((t, i) => [t.productId, i]));
      autoRows = rows
        .filter((r) => r.is_published && !pinnedSet.has(r.id))
        .sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
    } else {
      // Cold-start: no sales yet — fall back to newest so the page isn't empty.
      const rows = await productQueries.listPublishedProducts({ limit: autoFetch });
      autoRows = rows.filter((r) => !pinnedSet.has(r.id));
    }
  } else if (config.strategy === "on_promotion") {
    const wantEngine = config.promoStrategy === "engine" || config.promoStrategy === "both";
    const wantCompare = config.promoStrategy === "compare_at" || config.promoStrategy === "both";
    // Engine pool = every product a live auto-promotion touches; compare-at pool
    // = the catalogue-wide SQL selection of real card markdowns (NOT a newest-100
    // slice). Pinned products render first, so they're excluded from the pool.
    const pool = await loadPromotionPool({
      promoMap,
      wantEngine,
      wantCompare,
      exclude: pinnedSet,
      compareOrder: "deal",
    });
    // Strongest deal first — the deal the CARD shows (cheapest variant for a
    // variable product, engine promo folded in), newest first on a tie. Only the
    // final pinned + auto list is capped (by config.limit, below).
    pool.sort((a, b) => b.deal - a.deal || compareRowsNewest(a.row, b.row));
    autoRows = pool.map((c) => c.row);
  } else if (config.strategy === "preorder") {
    // Active-preorder products, soonest release first (undated last) — the mapper
    // surfaces them as "backorder"/"Précommande". Already published-filtered.
    const rows = await productQueries.listActivePreorderProducts({ limit: autoFetch });
    autoRows = rows.filter((r) => !pinnedSet.has(r.id));
  }

  // Pinned rows (published, in pin order).
  let pinnedRows: ProductRow[] = [];
  if (pinnedIds.length > 0) {
    const rows = await productQueries.listProductsByIds(pinnedIds);
    const byId = new Map(rows.filter((r) => r.is_published).map((r) => [r.id, r]));
    pinnedRows = pinnedIds
      .map((id) => byId.get(id))
      .filter((r): r is ProductRow => Boolean(r));
  }

  const combined = [...pinnedRows, ...autoRows].slice(0, limit);
  const products = await mapProductRows(combined);

  // Enrich card prices with the live engine discount (effective price).
  enrichWithLivePromos(products, combined, promoMap);

  return products;
}

/**
 * Unified product loader for the HOME block composer's listing blocks (product_rail /
 * product_grid). ONE entry point for every filterable source so a rail can pull from
 * newest / best-sellers / on-promotion / a CATEGORY / a BRAND / manual pins. Every
 * branch returns FULLY-ENRICHED products (live-promo card prices matching PDP/cart),
 * so parity holds regardless of source. `count` is clamped 1..48. Unknown/blank refs
 * yield []. best_sellers returns EMPTY when there is no sale in the window (the block
 * hides) — it deliberately does NOT fall back to newest, so it never silently
 * duplicates a Nouveautés block. The category/brand branches cap the id set to ~count
 * BEFORE enriching (a small buffer over count absorbs the post-enrich unpublish
 * filter) instead of enriching the whole tree then slicing.
 */
export async function listProductsForSource(
  source: import("@/lib/pages/home-blocks").ProductSource,
  count: number,
): Promise<Product[]> {
  const n = Math.max(1, Math.min(Math.round(count) || 8, 48));
  // Read a few more than N so the unpublish filter still leaves N.
  const buffered = n + 12;
  switch (source.mode) {
    case "new":
      return listNewArrivals(n);
    case "on_promotion":
      return listPromotions(n);
    case "best_sellers": {
      const top = await getTopSellingProducts(n + 4, source.windowDays);
      // No sale in the window → EMPTY (the rail/grid hides). It deliberately does NOT
      // cold-start to newest, so a best-sellers block never silently duplicates a
      // Nouveautés block (the storefront home's long-standing intent).
      if (top.length === 0) return [];
      return (await listProductsByIds(top.map((t) => t.productId))).slice(0, n);
    }
    case "category":
      return source.ref ? (await listProductsByCategory(source.ref, buffered)).slice(0, n) : [];
    case "brand":
      return source.ref ? (await listProductsByBrand(source.ref, buffered)).slice(0, n) : [];
    case "manual":
      return source.productIds.length ? (await listProductsByIds(source.productIds)).slice(0, n) : [];
    default:
      return [];
  }
}

// ─────────────────────────────────────────────── helpers
/**
 * Storefront grid products for a RAW link-table id set (category tree / brand /
 * related candidates — no ORDER BY, no published filter, may repeat drafts or
 * soft-deleted links). The published + live filter and a deterministic
 * newest-first order (published_at DESC NULLS LAST, id DESC) are applied IN SQL
 * BEFORE the grid cap, so the cap keeps the newest MAX_GRID_PRODUCTS published
 * products (drafts/deleted links never consume slots) and the natural order —
 * « En vedette » on category/brand pages, the first-12 view_item_list and the
 * JSON-LD ItemList — no longer reshuffles between requests (it was heap order).
 */
async function productsForIds(ids: string[], limit?: number): Promise<Product[]> {
  if (ids.length === 0) return [];
  let orderedIds = capGridIds(
    await productQueries.listPublishedIdsNewestFirst(ids),
    "productsForIds",
  );
  // For a bounded caller (a home rail/grid wanting N products) cap the id set to
  // `limit` BEFORE the heavy per-row read + live-promo enrichment, instead of
  // enriching the whole category tree (up to MAX_GRID_PRODUCTS) then slicing. The
  // caller passes a small buffer over N so the post-enrich unpublish filter still
  // has candidates. Pages pass no limit → full set (faceting needs it).
  if (limit != null) orderedIds = orderedIds.slice(0, limit);
  if (orderedIds.length === 0) return [];
  const rows = await productQueries.listProductsByIds(orderedIds);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Re-order to the SQL order (the IN (…) read returns heap order) and re-check
  // is_published (a concurrent unpublish between the two reads).
  const published = orderedIds
    .map((id) => byId.get(id))
    .filter((r): r is ProductRow => r !== undefined && r.is_published);
  return mapAndEnrichRows(published);
}

/**
 * Public DTO lookup by id, preserving the caller's order (used by the wishlist
 * page, where items are newest-first). Unpublished / missing ids are dropped.
 */
export async function listProductsByIds(ids: string[]): Promise<Product[]> {
  if (ids.length === 0) return [];
  const rows = await productQueries.listProductsByIds(ids);
  const published = rows.filter((r) => r.is_published);
  const mapped = await mapAndEnrichRows(published);
  const slugById = new Map(rows.map((r) => [r.id, r.slug]));
  const bySlug = new Map(mapped.map((p) => [p.slug, p]));
  const out: Product[] = [];
  for (const id of ids) {
    const slug = slugById.get(id);
    const p = slug ? bySlug.get(slug) : undefined;
    if (p) out.push(p);
  }
  return out;
}

/**
 * Batched row→`Product` mapper. Replaces the previous per-row `mapProductRow`
 * which fanned out 7+ queries per product (resulting in 700+ DB round-trips
 * for a single homepage render with 100 products).
 *
 * Now: a baseline of ~6-8 batched queries for simple products, regardless of
 * how many come in:
 *   1. product_media links by product_id IN (...)
 *   2. product_brand links by product_id IN (...)
 *   3. product_categories (primary) by product_id IN (...)
 *   4. media rows by media_id IN (...)
 *   5. categories rows by id IN (...) — covers both the primary category and
 *      its parent (we look up both in one batch)
 *
 * This is not a hard ceiling: variant-bearing batches add the variant +
 * variant-value-link + active-attribute-metadata queries, plus the always-run
 * global warranty + shared-stock-default lookups.
 *
 * Result preserves input order so callers can rely on the same shape as
 * `Promise.all(rows.map(mapProductRow))` returned before.
 */
async function mapProductRows(
  rows: Array<{
    id: string;
    slug: string;
    name: string;
    platform: string | null;
    sku: string | null;
    gtin?: string | null;
    mpn?: string | null;
    condition?: "new" | "used" | "refurbished" | null;
    product_type?: "simple" | "variable";
    warranty_months?: number | null;
    warranty_label?: string | null;
    short_desc: string;
    description: string;
    /** "Caractéristiques clés" bullets (jsonb string[]); optional so narrower row
     *  shapes still type-check (defaults to [] at map time). */
    highlights?: string[] | null;
    price_cents: number;
    old_price_cents: number | null;
    rating: string;
    reviews_count: number;
    in_stock: boolean;
    stock_qty?: number | null;
    min_purchase_qty?: number | null;
    max_purchase_qty?: number | null;
    shared_variant_stock?: boolean | null;
    video_url: string | null;
    video_poster_media_id?: string | null;
    video_title?: string | null;
    video_description?: string | null;
    meta_title?: string | null;
    meta_description?: string | null;
    canonical_url?: string | null;
    noindex?: boolean;
    og_image_media_id?: string | null;
    same_as?: string | null;
    // Publication instant for the storefront « Nouveautés » sort. Present on every
    // real ProductRow; optional here so narrower row shapes still type-check.
    published_at?: Date | null;
    // Précommande overlay — present on every real ProductRow; optional here so
    // narrower row shapes still type-check (absent ⇒ treated as non-preorder).
    is_preorder?: boolean;
    preorder_releases_at?: Date | null;
    preorder_message?: string | null;
  }>,
): Promise<Product[]> {
  if (rows.length === 0) return [];
  const productIds = rows.map((r) => r.id);

  // 3 round-trips in parallel — independent of row count. (Brands are resolved
  // in the second hop below, scoped to only the ids this page references,
  // rather than scanning the whole brands table here.)
  const [mediaLinksByProduct, brandIdByProduct, primaryCatByProduct] =
    await Promise.all([
      productMediaLink.listForProducts(productIds),
      productBrandLink.findBrandIdsForProducts(productIds),
      productCategoryLinks.primaryCategoriesForProducts(productIds),
    ]);

  // ── Variants — loaded ONLY when the batch contains `variable` products, so
  // lists of simple products pay nothing. We resolve the variant rows, their
  // attribute-value combos, and the attribute metadata for the PDP picker axes.
  // Loaded BEFORE the media batch so each variant's image_media_id joins the
  // SAME findMediaByIds call below (no extra round-trip). ─────────────────────
  const variableIds = rows.filter((r) => r.product_type === "variable").map((r) => r.id);
  const variantsByProduct = (
    variableIds.length > 0
      ? await productQueries.listVariantsForProducts(variableIds)
      : new Map()
  ) as Awaited<ReturnType<typeof productQueries.listVariantsForProducts>>;
  const allVariantIds = [...variantsByProduct.values()].flat().map((v) => v.id);
  const variantValueLinks =
    allVariantIds.length > 0
      ? await productQueries.listVariantValueLinks(allVariantIds)
      : new Map<string, string[]>();
  const attrValueMeta = new Map<
    string,
    { attributeId: string; attributeName: string; attrOrder: number; label: string; valueOrder: number }
  >();
  const usedValueIds = Array.from(new Set([...variantValueLinks.values()].flat()));
  if (usedValueIds.length > 0) {
    // Resolve ONLY the attribute values the variants actually reference (+ their
    // parent attributes) — not the whole attribute catalogue. Values have no
    // is_active/deleted_at; the parent ATTRIBUTE is fetched by id with NO
    // is_active/deleted_at filter (findAttributesByIds), so an existing variant's
    // axis still renders even if its attribute was later deactivated/archived
    // (deactivation governs the category-FILTER UI, not an existing variant's
    // axes — the picker only resolves when ids.length === options.length). Order
    // comes from the real display_order columns.
    const values = await attributeQueries.findValuesByIds(usedValueIds);
    const attrIds = Array.from(new Set(values.map((v) => v.attribute_id)));
    const attrs = await attributeQueries.findAttributesByIds(attrIds);
    const attrById = new Map(attrs.map((a) => [a.id, a]));
    for (const val of values) {
      const a = attrById.get(val.attribute_id);
      if (!a) continue;
      attrValueMeta.set(val.id, {
        attributeId: a.id,
        attributeName: a.name,
        attrOrder: a.display_order,
        label: val.label,
        valueOrder: val.display_order,
      });
    }
  }

  // 1 round-trip for all media + 1 for all categories. We batch category
  // lookups across BOTH the primary cats and their parents so the second
  // hop doesn't issue per-product queries.
  const mediaIds = Array.from(
    new Set(
      [
        ...[...mediaLinksByProduct.values()].flat().map((m) => m.media_id),
        // Resolve video poster images in the SAME batch as the gallery so
        // the poster doesn't cost an extra round-trip per product.
        ...rows
          .map((r) => r.video_poster_media_id)
          .filter((id): id is string => Boolean(id)),
        // Custom OG/social image overrides — resolved in the same batch too.
        ...rows
          .map((r) => r.og_image_media_id)
          .filter((id): id is string => Boolean(id)),
        // Per-variant images — resolved in the same batch as the gallery so a
        // variable product's variant thumbnails cost no extra round-trip.
        ...[...variantsByProduct.values()]
          .flat()
          .map((v) => v.image_media_id)
          .filter((id): id is string => Boolean(id)),
      ],
    ),
  );
  const primaryCatIds = Array.from(new Set([...primaryCatByProduct.values()]));
  const firstHopCats = await categoryService.findByIds(primaryCatIds);
  const parentIds = Array.from(
    new Set(
      [...firstHopCats.values()]
        .map((c) => c.parent_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  // Resolve ONLY the brands this page references (was a full brands-table scan
  // every render). findByIds short-circuits to [] for an empty set, so it
  // batches in parallel with the media/category second hop at no extra cost.
  const brandIds = Array.from(new Set([...brandIdByProduct.values()]));
  const [mediaMap, parentCats, brandRows] = await Promise.all([
    mediaIds.length > 0 ? mediaQueries.findMediaByIds(mediaIds) : Promise.resolve(new Map()),
    parentIds.length > 0 ? categoryService.findByIds(parentIds) : Promise.resolve(new Map()),
    brandService.findByIds(brandIds),
  ]);

  const brandsById = new Map(brandRows.map((b) => [b.id, b]));

  // Global warranty default (cached) — the base of the cascade resolved per row.
  const globalWarranty = await getDefaultWarranty();
  // FULL primary-category ancestor chains (child → root) for the warranty
  // cascade — same resolver as the order snapshot, so the PDP never shows a
  // different warranty than the one frozen on the order line. Seeded with the
  // two hops loaded above: a 2-level tree costs no extra query, deeper trees
  // fetch only the missing ancestors.
  const warrantyChains = await loadCategoryChains(primaryCatIds, {
    seed: [...firstHopCats.values(), ...parentCats.values()],
    lookedUp: [...primaryCatIds, ...parentIds],
  });
  // Global variant-stock-mode default — resolved once for the whole batch so a
  // SHARED variable product's variants reflect the PARENT pool's availability.
  const sharedStockDefault = await getSharedStockDefault();

  return rows.map((row) => {
    const mediaList = mediaLinksByProduct.get(row.id) ?? [];
    const galleryUrls: string[] = [];
    // AVIF-avoiding parallel of galleryUrls, for the product feeds (Merchant/ACP
    // reject AVIF). Same order/length as galleryUrls.
    const gallerySocialUrls: string[] = [];
    // Alt text parallel to galleryUrls — the Médiathèque alt of each media,
    // falling back to the product name so an alt is never empty/ugly.
    const galleryAlts: string[] = [];
    // Compat URL of the FIRST image for OG / social (AVIF-avoiding).
    let ogImage: string | undefined;
    for (const link of mediaList) {
      const m = mediaMap.get(link.media_id);
      const url = resolveMediaUrl(m);
      if (!url) continue;
      const social = resolveMediaSocialUrl(m) ?? url;
      if (ogImage === undefined) {
        ogImage = social;
      }
      galleryUrls.push(url);
      gallerySocialUrls.push(social);
      galleryAlts.push(resolveMediaAlt(m) ?? row.name);
    }
    const imageUrl: string = galleryUrls[0] ?? PLACEHOLDER_IMAGE;
    const imageAlt: string = galleryAlts[0] ?? row.name;

    // A per-product OG override (SEO tab) wins over the auto-derived primary
    // image. Compat (never-AVIF) resolver — OG scrapers can't render AVIF.
    if (row.og_image_media_id) {
      const ogOverride = resolveMediaSocialUrl(mediaMap.get(row.og_image_media_id));
      if (ogOverride) ogImage = ogOverride;
    }

    const brandId = brandIdByProduct.get(row.id);
    // Only surface ACTIVE brands on the storefront (an archived brand 404s on
    // its landing page, so we must not render a dead name/link for it).
    const brandRow = brandId ? brandsById.get(brandId) : undefined;
    const brandActive = brandRow?.is_active === true;
    const brandName = brandActive ? brandRow!.name : "";
    const brandSlug = brandActive ? brandRow!.slug : "";

    // Empty (NOT a fake "montres" slug) when the product has no resolvable
    // primary category — a hardcoded default produced a /montres breadcrumb
    // link + JSON-LD item that 404s (no such root category). Callers guard on
    // an empty category before rendering a crumb/link.
    let categorySlug: CategorySlug = "";
    let categoryName = "";
    let subcategorySlug: string | undefined;
    const primaryCatId = primaryCatByProduct.get(row.id);
    if (primaryCatId) {
      const node = firstHopCats.get(primaryCatId);
      if (node) {
        if (node.parent_id) {
          const parent = parentCats.get(node.parent_id);
          categorySlug = (parent?.slug ?? node.slug) as CategorySlug;
          categoryName = parent?.name ?? node.name;
          subcategorySlug = node.slug;
        } else {
          categorySlug = node.slug as CategorySlug;
          categoryName = node.name;
        }
      }
    }

    // Warranty cascade — product → primary category chain (child → root) → global.
    const warranty = resolveWarranty(
      { months: row.warranty_months ?? null, label: row.warranty_label ?? null },
      categoryWarrantyFromChain(primaryCatId ? warrantyChains.get(primaryCatId) : null),
      globalWarranty,
    );

    // Resolve the video poster (if set) from the same media batch as the
    // gallery. Falls back to undefined → the component uses the primary
    // product image. Uses the COMPAT (webp-first, never-AVIF) resolver
    // because the poster lands in a raw `<video poster>` attribute, which
    // Next can't format-negotiate — an AVIF poster would silently fail on
    // browsers without AVIF support. The on-page `<Image>` overlay still
    // up-negotiates the webp source back to AVIF for capable browsers.
    const posterUrl = row.video_poster_media_id
      ? resolveMediaSocialUrl(mediaMap.get(row.video_poster_media_id)) ?? undefined
      : undefined;
    const posterAlt = row.video_poster_media_id
      ? resolveMediaAlt(mediaMap.get(row.video_poster_media_id)) ?? undefined
      : undefined;

    // Build the storefront variant DTOs + picker axes for variable products.
    // In SHARED mode every variant draws from the PARENT pool, so its effective
    // availability is (its own in_stock toggle AND the pool) over the parent's
    // stock_qty — mapped here so the existing variantInStock() guard, the picker,
    // and displayInStock all behave correctly without per-variant counts.
    const variantRows = variantsByProduct.get(row.id) ?? [];
    const sharedStock =
      row.product_type === "variable" && isSharedStock(row.shared_variant_stock, sharedStockDefault);
    const variants = variantRows.map((v) => {
      // Per-variant image (resolved from the shared media batch). Display
      // (AVIF-first) resolver to match the gallery; alt falls back to the
      // product name like galleryAlts. A deleted media id resolves to undefined
      // (findMediaByIds filters deleted_at) → the PDP falls back to the gallery,
      // honouring the schema's "falls back to the product gallery" contract.
      const vMedia = v.image_media_id ? mediaMap.get(v.image_media_id) : undefined;
      const vImg = resolveMediaUrl(vMedia);
      const vImgSocial = resolveMediaSocialUrl(vMedia);
      return {
        id: v.id,
        label: v.label,
        sku: v.sku ?? undefined,
        gtin: v.gtin ?? null,
        priceCents: v.price_cents,
        oldPriceCents: v.old_price_cents ?? undefined,
        inStock: sharedStock ? v.in_stock && row.in_stock : v.in_stock,
        stockQty: sharedStock ? (row.stock_qty ?? null) : v.stock_qty,
        isDefault: v.is_default,
        // Drop value ids whose attribute/value meta no longer resolves (a removed
        // or deactivated attribute): they'd otherwise be axes the picker can't
        // build, leaving the variant unmatchable. The picker is also defensive
        // (see variant-match.ts), but keeping the DTO honest avoids stale ids.
        optionValueIds: (variantValueLinks.get(v.id) ?? []).filter((id) => attrValueMeta.has(id)),
        image: vImg ?? undefined,
        imageAlt: vImg ? (resolveMediaAlt(vMedia) ?? row.name) : undefined,
        imageSocial: vImgSocial ?? undefined,
      };
    });
    const optionAcc = new Map<
      string,
      { attributeId: string; name: string; attrOrder: number; values: Map<string, { id: string; label: string; order: number }> }
    >();
    for (const vr of variants) {
      for (const vid of vr.optionValueIds) {
        const meta = attrValueMeta.get(vid);
        if (!meta) continue;
        let entry = optionAcc.get(meta.attributeId);
        if (!entry) {
          entry = { attributeId: meta.attributeId, name: meta.attributeName, attrOrder: meta.attrOrder, values: new Map() };
          optionAcc.set(meta.attributeId, entry);
        }
        if (!entry.values.has(vid)) entry.values.set(vid, { id: vid, label: meta.label, order: meta.valueOrder });
      }
    }
    const variantOptions = [...optionAcc.values()]
      .sort((a, b) => a.attrOrder - b.attrOrder)
      .map((e) => ({
        attributeId: e.attributeId,
        name: e.name,
        values: [...e.values.values()].sort((a, b) => a.order - b.order).map((v) => ({ id: v.id, label: v.label })),
      }));

    // For a variable product the displayed price is the cheapest variant
    // ("à partir de"), and it's in stock if ANY variant is EFFECTIVELY in stock
    // (in_stock flag set AND not a tracked-but-zero line) — so a variant left at
    // `in_stock=true, stock_qty=0` no longer shows the product as available.
    // The displayed price for a variable product is the CHEAPEST variant; its
    // compare-at (oldPrice) must come from that SAME variant, not the parent
    // row — else a parent old_price_cents above the cheapest variant's price
    // renders a strikethrough / −X% badge that matches no real variant. The
    // compare-at is normalised to null unless STRICTLY above the price (a stale
    // value left after a price increase must not render a « was » price at or
    // below the current one) — the SAME rule the promotion pools test
    // (lib/listing/display-pricing.ts).
    const { priceCents: displayPriceCents, oldPriceCents: displayOldPriceCents } =
      listingDisplayPricing(row, variants);
    // A SIMPLE product is available only if the flag is set AND it isn't a
    // tracked-but-zero line (in_stock=true, stock_qty=0) — same effective guard
    // the order path applies, so cards/PDP never advertise an unbuyable SKU.
    // A VARIABLE product with no live variant is never available: add-to-cart and
    // place-order both refuse a variant-less line on it, so advertising it as in
    // stock (PDP buy button, card badge, JSON-LD Offer, feeds) would be a dead end.
    const displayInStock =
      variants.length > 0
        ? variants.some(variantInStock)
        : row.product_type !== "variable" && row.in_stock && (row.stock_qty == null || row.stock_qty > 0);

    // PRÉCOMMANDE: an active-preorder product sells regardless of stock — it
    // reserves units (see @/lib/inventory/preorder + place-order). Surface it as
    // the storefront's "backorder" state ("Précommande" label, orderable CTA,
    // schema.org/PreOrder, feed availability) once it releases it reverts to a
    // normal in/out sale. SSOT: computed ONCE here for cards, export, PDP + feeds.
    const preorderActive = isActivePreorder({
      is_preorder: row.is_preorder ?? false,
      preorder_releases_at: row.preorder_releases_at ?? null,
    });
    const availability: "in_stock" | "out_of_stock" | "backorder" = preorderActive
      ? "backorder"
      : displayInStock
        ? "in_stock"
        : "out_of_stock";

    // Official-URL sameAs → validated absolute http(s) list (single parse here;
    // the PDP gates emission on the global seo.product_sameas_enabled switch).
    const sameAs = parseSameAs(row.same_as);

    return {
      // Product UUID — the ONE GA4 item_id scheme (listing view_item_list /
      // select_item join the PDP / cart / purchase events, which send it too).
      id: row.id,
      slug: row.slug,
      name: row.name,
      brand: brandName,
      brandSlug,
      category: categorySlug,
      categoryName: categoryName || undefined,
      subcategory: subcategorySlug,
      platform: row.platform ?? undefined,
      sku: row.sku ?? undefined,
      gtin: row.gtin ?? undefined,
      mpn: row.mpn ?? undefined,
      condition: row.condition ?? "new",
      productType: row.product_type ?? "simple",
      minPurchaseQty: row.min_purchase_qty ?? null,
      maxPurchaseQty: row.max_purchase_qty ?? null,
      warranty: warranty.display ?? undefined,
      warrantyMonths: warranty.months > 0 ? warranty.months : undefined,
      // Keep the lossy major-unit fields for display compat (legacy callers),
      // but expose the canonical cents alongside so analytics + payments
      // never re-multiply a rounded value back into cents (precision drift).
      price: minorToDinars(displayPriceCents),
      oldPrice: displayOldPriceCents ? minorToDinars(displayOldPriceCents) : undefined,
      priceCents: displayPriceCents,
      oldPriceCents: displayOldPriceCents ?? undefined,
      // Variants + their picker axes (undefined for simple products).
      variants: variants.length > 0 ? variants : undefined,
      variantOptions: variantOptions.length > 0 ? variantOptions : undefined,
      rating: Number(row.rating),
      reviews: row.reviews_count,
      // Publication instant (ISO) for the storefront « Nouveautés » sort.
      publishedAt: row.published_at?.toISOString(),
      image: imageUrl,
      imageAlt,
      images: galleryUrls.length > 0 ? galleryUrls : undefined,
      imagesSocial: gallerySocialUrls.length > 0 ? gallerySocialUrls : undefined,
      imagesAlt: galleryAlts.length > 0 ? galleryAlts : undefined,
      ogImage: ogImage ?? (imageUrl !== PLACEHOLDER_IMAGE ? imageUrl : undefined),
      // SEO overrides — all optional; the PDP + generateMetadata fall back to
      // name / shortDesc / `${SITE_URL}/${slug}` when unset (see [slug]/page).
      metaTitle: row.meta_title ?? undefined,
      metaDescription: row.meta_description ?? undefined,
      canonicalUrl: row.canonical_url ?? undefined,
      noindex: row.noindex === true,
      sameAs: sameAs.length > 0 ? sameAs : undefined,
      shortDesc: row.short_desc,
      description: row.description,
      highlights: row.highlights ?? [],
      inStock: displayInStock,
      availability,
      // Dated active preorder only → drives the PDP release note + feed
      // availability_date; null for an undated/indefinite preorder or non-preorder.
      preorderReleasesAt: preorderActive ? (row.preorder_releases_at?.toISOString() ?? null) : null,
      preorderMessage: preorderActive ? (row.preorder_message ?? null) : null,
      videoUrl: row.video_url ?? undefined,
      videoPoster: posterUrl,
      videoPosterAlt: posterAlt,
      videoTitle: row.video_title ?? undefined,
      videoDescription: row.video_description ?? undefined,
    } satisfies Product;
  });
}
