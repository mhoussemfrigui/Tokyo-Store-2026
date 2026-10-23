import "server-only";

import { cacheTag, cacheLife } from "next/cache";

import { CACHE_TAGS } from "@/lib/cache/tags";
import { isBuildPhase } from "@/lib/cache/build-phase";

import type { AttributeKind } from "@/modules/catalog/attribute/schema";
import { categoryQueries } from "@/modules/catalog/category";
import type { CategoryTreeNode } from "@/modules/catalog/category/queries";
import { categoryService } from "@/modules/catalog/category/service";
import { loadCategoryChains } from "@/lib/catalog/category-chain";
import type { CategoryRow } from "@/modules/catalog/category/schema";
import { attributeQueries, attributeService } from "@/modules/catalog/attribute";
import { productQueries } from "@/modules/catalog/product";
import { productCategoryLinks } from "@/associations/catalog.service";
import type { Category, CategorySlug, Subcategory } from "@/types/catalog";

/**
 * Attribute-filter shape consumed by `CategoryPageClient`. One entry per
 * attribute opted-in for the category (Matière, Mouvement, Étanchéité…), each
 * carrying the value options shown as filter checkboxes.
 */
export type CategoryFilterAttribute = {
  id: string;
  slug: string;
  name: string;
  kind: AttributeKind;
  values: Array<{ id: string; slug: string; label: string; colorHex?: string | null }>;
  /** For kind="number": the min/max across the page's products (range slider). */
  numericRange?: { min: number; max: number } | null;
};

export type CategoryAttributeFilters = {
  filterAttributes: CategoryFilterAttribute[];
  /** Map of product slug → the value IDs that product is assigned to. */
  productValueIds: Record<string, string[]>;
  /**
   * Map of product slug → { attributeId → numeric scalar } for kind="number"
   * attributes — drives the storefront range filter (a product without a value
   * for a number filter is excluded while that filter is active).
   */
  productNumericValues: Record<string, Record<string, number>>;
};

/**
 * Resolve the opt-in attribute filters for a category plus the per-product
 * value assignments needed to apply them client-side. Shared by BOTH the root
 * category page and the sub-category page so leaf categories (where most
 * products live) get the same filters the root page already shows.
 *
 * `categoryId` is the raw category row id; `products` are the in-scope products
 * (the page's `baseProducts`) as {id, slug} pairs — the storefront DTOs already
 * carry both, so no slug→id round trip is needed. Every query degrades to an
 * empty result on failure so a missing attribute table never breaks the page.
 */
export async function getCategoryAttributeFilters(
  categoryId: string,
  products: Array<{ id: string; slug: string }>,
): Promise<CategoryAttributeFilters> {
  const [linkedAttributeIds, attributesWithValues] = await Promise.all([
    attributeService.listCategoryFilters(categoryId).catch(() => [] as string[]),
    attributeQueries.listAttributesWithValues().catch(() => []),
  ]);
  const byId = new Map(attributesWithValues.map((a) => [a.id, a]));
  const filterAttributes: CategoryFilterAttribute[] = linkedAttributeIds
    .map((id) => byId.get(id))
    .filter((a): a is (typeof attributesWithValues)[number] => Boolean(a) && a!.is_active)
    // `text` is informational (shown on the PDP), never a category filter.
    .filter((a) => a.kind !== "text")
    .map((a) => ({
      id: a.id,
      slug: a.slug,
      name: a.name,
      kind: a.kind,
      values: a.values.map((v) => ({
        id: v.id,
        slug: v.slug,
        label: v.label,
        colorHex: v.color_hex,
      })),
    }));

  const numberAttrIds = new Set(
    filterAttributes.filter((a) => a.kind === "number").map((a) => a.id),
  );

  let productValueIds: Record<string, string[]> = {};
  let productNumericValues: Record<string, Record<string, number>> = {};
  if (filterAttributes.length > 0 && products.length > 0) {
    // The scoped products already carry their ids (storefront DTOs), so build
    // the id↔slug maps directly — no slug→id round trip. (listProductsBySlugs
    // was legacy from before the DTO carried `id`; the SEARCH variant below
    // still needs it because its hits don't.)
    const slugToId = new Map<string, string>();
    for (const p of products) {
      if (p.id) slugToId.set(p.slug, p.id);
    }
    if (slugToId.size > 0) {
      const productIds = Array.from(slugToId.values());
      const idToSlug = new Map(
        Array.from(slugToId.entries()).map(([s, i]) => [i, s]),
      );
      // Value-id assignments (select/multiselect/color/boolean filters) +
      // numeric scalars (number filters) batched together — anti-N+1.
      const [valueMap, scalarMap] = await Promise.all([
        attributeService.listValueIdsForProducts(productIds).catch(() => new Map<string, string[]>()),
        numberAttrIds.size > 0
          ? attributeService.listScalarsForProducts(productIds).catch(() => new Map())
          : Promise.resolve(new Map()),
      ]);

      const acc: Record<string, string[]> = {};
      for (const [productId, valueIds] of valueMap.entries()) {
        const productSlug = idToSlug.get(productId);
        if (productSlug) acc[productSlug] = valueIds;
      }
      productValueIds = acc;

      if (numberAttrIds.size > 0) {
        const ranges = new Map<string, { min: number; max: number }>();
        const numAcc: Record<string, Record<string, number>> = {};
        for (const [productId, rows] of scalarMap.entries()) {
          const productSlug = idToSlug.get(productId);
          for (const r of rows) {
            if (!numberAttrIds.has(r.attribute_id) || r.numeric_value == null) continue;
            const n = Number(r.numeric_value);
            if (!Number.isFinite(n)) continue;
            if (productSlug) {
              (numAcc[productSlug] ??= {})[r.attribute_id] = n;
            }
            const cur = ranges.get(r.attribute_id);
            if (!cur) ranges.set(r.attribute_id, { min: n, max: n });
            else ranges.set(r.attribute_id, { min: Math.min(cur.min, n), max: Math.max(cur.max, n) });
          }
        }
        productNumericValues = numAcc;
        // Attach the computed range to each number filter (null when no product
        // carries a value, so the client can hide an empty range).
        for (const fa of filterAttributes) {
          if (fa.kind === "number") fa.numericRange = ranges.get(fa.id) ?? null;
        }
      }
    }
  }

  return { filterAttributes, productValueIds, productNumericValues };
}

/**
 * Like {@link getCategoryAttributeFilters} but NOT scoped to a category — used
 * by storefront SEARCH, whose results span many categories. The filterable
 * attributes are the UNION of the attributes actually assigned across the
 * matched products (so the facets reflect exactly what's on screen) instead of
 * a single category's opt-in list. Same output contract, so `CategoryPageClient`
 * consumes it unchanged. Degrades to empty on any failure.
 */
export async function getProductsAttributeFilters(
  productSlugs: string[],
): Promise<CategoryAttributeFilters> {
  const empty: CategoryAttributeFilters = {
    filterAttributes: [],
    productValueIds: {},
    productNumericValues: {},
  };
  const baseSlugs = Array.from(new Set(productSlugs));
  if (baseSlugs.length === 0) return empty;

  const [attributesWithValues, slugRows] = await Promise.all([
    attributeQueries.listAttributesWithValues().catch(() => []),
    productQueries.listProductsBySlugs(baseSlugs).catch(() => []),
  ]);
  if (slugRows.length === 0) return empty;

  const slugToId = new Map<string, string>();
  for (const r of slugRows) slugToId.set(r.slug, r.id);
  const idToSlug = new Map(Array.from(slugToId.entries()).map(([s, i]) => [i, s]));
  const productIds = Array.from(slugToId.values());

  const attrById = new Map(attributesWithValues.map((a) => [a.id, a]));
  // valueId → attributeId so an assigned value reveals its parent attribute.
  const valueIdToAttrId = new Map<string, string>();
  for (const a of attributesWithValues) {
    for (const v of a.values) valueIdToAttrId.set(v.id, a.id);
  }

  const [valueMap, scalarMap] = await Promise.all([
    attributeService
      .listValueIdsForProducts(productIds)
      .catch(() => new Map<string, string[]>()),
    attributeService.listScalarsForProducts(productIds).catch(() => new Map()),
  ]);

  // The attributes actually present across the matched products.
  const presentAttrIds = new Set<string>();
  for (const valueIds of valueMap.values()) {
    for (const vId of valueIds) {
      const attrId = valueIdToAttrId.get(vId);
      if (attrId) presentAttrIds.add(attrId);
    }
  }
  for (const rows of scalarMap.values()) {
    for (const r of rows) {
      if (r.numeric_value != null) presentAttrIds.add(r.attribute_id);
    }
  }

  const filterAttributes: CategoryFilterAttribute[] = Array.from(presentAttrIds)
    .map((id) => attrById.get(id))
    .filter((a): a is (typeof attributesWithValues)[number] => Boolean(a) && a!.is_active)
    // `text` is informational (shown on the PDP), never a filter.
    .filter((a) => a.kind !== "text")
    .map((a) => ({
      id: a.id,
      slug: a.slug,
      name: a.name,
      kind: a.kind,
      values: a.values.map((v) => ({
        id: v.id,
        slug: v.slug,
        label: v.label,
        colorHex: v.color_hex,
      })),
    }))
    // Search has no opt-in order, so sort alphabetically for a deterministic
    // sidebar (the category path relies on the opt-in display order instead).
    .sort((x, y) => x.name.localeCompare(y.name, "fr"));

  if (filterAttributes.length === 0) return empty;

  const numberAttrIds = new Set(
    filterAttributes.filter((a) => a.kind === "number").map((a) => a.id),
  );

  const productValueIds: Record<string, string[]> = {};
  for (const [productId, valueIds] of valueMap.entries()) {
    const productSlug = idToSlug.get(productId);
    if (productSlug) productValueIds[productSlug] = valueIds;
  }

  const productNumericValues: Record<string, Record<string, number>> = {};
  if (numberAttrIds.size > 0) {
    const ranges = new Map<string, { min: number; max: number }>();
    for (const [productId, rows] of scalarMap.entries()) {
      const productSlug = idToSlug.get(productId);
      for (const r of rows) {
        if (!numberAttrIds.has(r.attribute_id) || r.numeric_value == null) continue;
        const n = Number(r.numeric_value);
        if (!Number.isFinite(n)) continue;
        if (productSlug) (productNumericValues[productSlug] ??= {})[r.attribute_id] = n;
        const cur = ranges.get(r.attribute_id);
        if (!cur) ranges.set(r.attribute_id, { min: n, max: n });
        else ranges.set(r.attribute_id, { min: Math.min(cur.min, n), max: Math.max(cur.max, n) });
      }
    }
    for (const fa of filterAttributes) {
      if (fa.kind === "number") fa.numericRange = ranges.get(fa.id) ?? null;
    }
  }

  return { filterAttributes, productValueIds, productNumericValues };
}

/**
 * Storefront-facing category API — DB-backed.
 *
 * Maps the new module shape to the legacy `Category` (roots with inline
 * `subcategories[]` + a `count` computed live).
 *
 * For 2-level taxonomies this is efficient: one SELECT for the tree, one
 * COUNT per root. When category writes start moving, wrap these reads with
 * `'use cache'` + `cacheTag('category:tree')` and revalidate from the
 * category workflows on insert/update/delete.
 */

// CROSS-REQUEST cached (`'use cache'`): the mega-menu calls this on EVERY
// storefront page, and it runs the category-tree SELECT + a recursive-CTE
// COUNT(DISTINCT) roll-up per root — the single biggest repeated per-request cost
// in the storefront. Tagged `categories` (busted on any category write) AND
// `products:list` (busted on any product create/update/publish/unpublish/delete)
// so the "X produits" counts stay read-your-writes fresh; `cacheLife("hours")` is
// just the fallback ceiling.
//
// Build-phase guard (see @/lib/cache/build-phase): the shop LAYOUT renders this nav
// while statically prerendering pages at build, where there is no DB — and a
// `'use cache'` throw there is a fatal, uncatchable prerender error. Return empty
// during the build (every shop page is dynamic at runtime, so it's never served).
export async function listCategories(): Promise<Category[]> {
  if (isBuildPhase()) return [];
  return listCategoriesCached();
}
async function listCategoriesCached(): Promise<Category[]> {
  "use cache";
  cacheLife("hours");
  cacheTag(CACHE_TAGS.categories, CACHE_TAGS.productsList);
  const tree = await categoryQueries.getCategoryTree();

  // Storefront-facing: drop deactivated categories (and deactivated
  // children) so the nav / homepage / API never links to a category that
  // 404s at /[slug]. The ADMIN tree reads `getCategoryTree` directly and is
  // intentionally NOT filtered here. `is_active` is not surfaced on the DTO —
  // the storefront only ever sees the active set.
  const activeRoots = tree.filter((n) => n.is_active);

  // Single batch query for all root counts — replaces the previous N
  // round-trips (one per root) the homepage was issuing.
  const countMap = await productCategoryLinks.countProductsForCategoryTrees(
    activeRoots.map((n) => n.id),
  );

  return activeRoots.map((node) => {
    return {
      slug: node.slug as CategorySlug,
      name: node.name,
      tagline: node.tagline ?? "",
      count: countMap.get(node.id) ?? 0,
      subcategories: mapActiveSubcategoryTree(node.children),
      noindex: node.noindex,
      icon: node.icon ?? null,
      iconMediaId: node.icon_media_id ?? null,
      boutiqueImageMediaId: node.boutique_image_media_id ?? null,
    } satisfies Category;
  });
}

/**
 * Recursive active-only projection of a category subtree into the storefront
 * `Subcategory[]` shape (slug/name/editable chip icon + nested `children`).
 * Shared by the mega-menu tree (listCategoriesCached) AND the category-page DTO
 * (getCategoryBySlug) so both expose the SAME nested depth the client facet
 * tree + `pruneSubcategoryTree` already assume — the page path used to ship
 * only direct children, so the in-place "Catégorie" filter emptied out (and
 * hid) on any root/hub page ≥2 levels above where products are filed.
 */
export function mapActiveSubcategoryTree(children: CategoryTreeNode[]): Subcategory[] {
  return children
    .filter((c) => c.is_active)
    .map((c) => {
      const nested = mapActiveSubcategoryTree(c.children ?? []);
      return {
        slug: c.slug,
        name: c.name,
        icon: c.icon ?? null,
        iconMediaId: c.icon_media_id ?? null,
        ...(nested.length > 0 ? { children: nested } : {}),
      } satisfies Subcategory;
    });
}

// CROSS-REQUEST cached (`'use cache'`): the /[slug] resolver calls this in BOTH
// generateMetadata and the page render. Tagged `categories` + `products:list` so
// a category edit OR a product write (which changes the count) busts it instantly;
// `cacheLife("hours")` is the fallback ceiling.
export async function getCategoryBySlug(slug: string): Promise<Category | null> {
  "use cache";
  cacheLife("hours");
  cacheTag(CACHE_TAGS.categories, CACHE_TAGS.productsList);
  const node = await categoryQueries.getCategoryBySlug(slug);
  if (!node) return null;
  // The NESTED subtree + product count are independent — fetch in parallel.
  // We ship the FULL nested descendant tree (active-only, mirroring the mega
  // menu) — not just direct children — so the client's recursive "Catégorie"
  // facet + pruneSubcategoryTree can keep the branches that actually hold
  // products on a root/hub page instead of pruning to empty and hiding the
  // filter. Inactive descendants are dropped (a deactivated category 404s at
  // /[slug], so a chip/facet entry for it would dead-end).
  const [childTree, countMap] = await Promise.all([
    categoryQueries.getCategorySubtreeChildren(node.id),
    productCategoryLinks.countProductsForCategoryTrees([node.id]),
  ]);
  return {
    slug: node.slug as CategorySlug,
    name: node.name,
    tagline: node.tagline ?? "",
    count: countMap.get(node.id) ?? 0,
    subcategories: mapActiveSubcategoryTree(childTree),
    noindex: node.noindex,
    icon: node.icon ?? null,
    iconMediaId: node.icon_media_id ?? null,
  };
}

/**
 * Ancestor chain for a category, ordered root → … → immediate parent and
 * EXCLUDING the category itself. Powers the category-page breadcrumb, which
 * renders the full path (Accueil / ‹grand-parent› / ‹parent› / current).
 *
 * Walks `parent_id` up the tree via the category service. Slugs are globally
 * unique on the flat /[slug] namespace, so each `{ slug, name }` resolves to a
 * real, navigable page. A defensive depth cap guards against a malformed cycle
 * in the self-FK (the tree is at most 4 levels deep in practice).
 */
export async function getCategoryAncestors(
  slug: string,
): Promise<{ slug: string; name: string }[]> {
  const node = await categoryService.findBySlug(slug);
  if (!node) return [];
  // Reuse the shared, cycle-safe, batched chain resolver (seeded with the node so
  // its own row costs no extra query) instead of a second hand-rolled parent walk
  // — one implementation for every "walk to the root" path. `loadCategoryChains`
  // returns the chain child → root INCLUDING the node itself at index 0, and only
  // LIVE ancestors (a soft-deleted parent ends the chain), matching the old walk.
  const chain = (await loadCategoryChains([node.id], { seed: [node] })).get(node.id) ?? [];
  // Drop the node itself (index 0) and reverse child→root into root → … → parent.
  return chain.slice(1).reverse().map((c) => ({ slug: c.slug, name: c.name }));
}

// ─────────────────────────────────── External API (ERP) reads + reference
/**
 * The external-API category shape — a FLAT projection of the raw row carrying
 * everything a headless / ERP client needs to round-trip & reconcile: the uuid
 * `id`, the `externalRef`, the `parentId` (for tree reconstruction), and the
 * SEO/content fields. Distinct from the storefront `Category` (nested tree,
 * active-only) which the public list endpoint returns.
 */
export type ApiCategory = {
  id: string;
  slug: string;
  name: string;
  externalRef: string | null;
  parentId: string | null;
  tagline: string | null;
  description: string | null;
  isActive: boolean;
  isDiscountable: boolean;
  displayOrder: number;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
  // Every field the write path (create/update) accepts is also READ back here,
  // so a keyed ERP caller can round-trip + reconcile what it just PUT/PATCH'd
  // (tax/warranty tier, hero/og/listing icon media, editorial block, and the
  // value-prop cards incl. their optional custom iconMediaId).
  warrantyMonths: number | null;
  warrantyLabel: string | null;
  taxRateBps: number | null;
  heroMediaId: string | null;
  boutiqueImageMediaId: string | null;
  ogImageMediaId: string | null;
  icon: string | null;
  iconMediaId: string | null;
  editorialEyebrow: string | null;
  editorialTitle: string | null;
  editorialBody: string | null;
  valueProps: CategoryRow["value_props"];
};

/** A reference an external caller can address a category by (caller picks ONE). */
export type CategoryRef = {
  categoryId?: string | null;
  externalRef?: string | null;
  slug?: string | null;
};

function toApiCategory(row: CategoryRow): ApiCategory {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    externalRef: row.external_ref ?? null,
    parentId: row.parent_id ?? null,
    tagline: row.tagline ?? null,
    description: row.description ?? null,
    isActive: row.is_active,
    isDiscountable: row.is_discountable,
    displayOrder: row.display_order,
    metaTitle: row.meta_title ?? null,
    metaDescription: row.meta_description ?? null,
    canonicalUrl: row.canonical_url ?? null,
    noindex: row.noindex,
    warrantyMonths: row.warranty_months ?? null,
    warrantyLabel: row.warranty_label ?? null,
    taxRateBps: row.tax_rate_bps ?? null,
    heroMediaId: row.hero_media_id ?? null,
    boutiqueImageMediaId: row.boutique_image_media_id ?? null,
    ogImageMediaId: row.og_image_media_id ?? null,
    icon: row.icon ?? null,
    iconMediaId: row.icon_media_id ?? null,
    editorialEyebrow: row.editorial_eyebrow ?? null,
    editorialTitle: row.editorial_title ?? null,
    editorialBody: row.editorial_body ?? null,
    valueProps: row.value_props ?? null,
  };
}

/**
 * Resolve a single LIVE category ROW by an EXPLICIT reference — the caller picks
 * the field; this is NOT a fallback chain (a present-but-unmatched key returns
 * null rather than trying the next). O(1) per lookup via the id / external_ref
 * unique indexes (slug is indexed too). Resolves at ANY depth and regardless of
 * `is_active` so a keyed ERP caller can read/sync inactive categories.
 */
export async function resolveCategoryRow(ref: CategoryRef): Promise<CategoryRow | null> {
  if (ref.categoryId) return categoryService.findById(ref.categoryId);
  if (ref.externalRef) return categoryService.findByExternalRef(ref.externalRef);
  if (ref.slug) return categoryService.findBySlug(ref.slug);
  return null;
}

/**
 * Single-category read for the external API, addressed by ANY reference.
 * `activeOnly` (the PUBLIC path) hides inactive/draft categories from anonymous
 * callers — mirroring how products hide unpublished rows on the public path.
 * A TRUSTED keyed caller (activeOnly=false) sees inactive rows so an ERP can
 * read/sync drafts.
 */
export async function getApiCategoryByRef(
  ref: CategoryRef,
  opts: { activeOnly?: boolean } = {},
): Promise<ApiCategory | null> {
  const row = await resolveCategoryRow(ref);
  if (!row) return null;
  if (opts.activeOnly && !row.is_active) return null;
  return toApiCategory(row);
}

/**
 * Flat list of live categories for the external API (ERP enumeration).
 * `activeOnly` (the PUBLIC path) drops inactive categories so the public flat
 * list matches the storefront contract (the nested storefront tree is already
 * active-only); keyed ERP callers get the full set.
 */
export async function listApiCategories(
  opts: { activeOnly?: boolean } = {},
): Promise<ApiCategory[]> {
  const rows = await categoryService.listAll();
  const visible = opts.activeOnly ? rows.filter((r) => r.is_active) : rows;
  return visible.map(toApiCategory);
}

export async function getSubcategoryCounts(
  categorySlug: string,
): Promise<Map<string, number>> {
  // Any-depth resolve — mid-tree categories (telephonie, smartphones…)
  // have children of their own.
  const parent = await categoryService.findBySlug(categorySlug);
  if (!parent) return new Map();
  // Active-only: counts must align with the storefront child chips, which hide
  // inactive children (see getCategoryBySlug).
  const children = (await categoryService.listChildren(parent.id)).filter((c) => c.is_active);
  if (children.length === 0) return new Map();
  // Single batch query — was previously N round-trips (one per child).
  const countById = await productCategoryLinks.countProductsForCategoryTrees(
    children.map((c) => c.id),
  );
  const out = new Map<string, number>();
  for (const c of children) out.set(c.slug, countById.get(c.id) ?? 0);
  return out;
}
