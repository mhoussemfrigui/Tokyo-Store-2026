import "server-only";

import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { loadCategoryChains } from "@/lib/catalog/category-chain";
import { products } from "@/modules/catalog/product/schema";
import { categories } from "@/modules/catalog/category/schema";
import { brands } from "@/modules/catalog/brand/schema";
import { product_categories } from "@/associations/product-category";
import { product_brands } from "@/associations/product-brand";
import { productCategoryLinks, productBrandLink } from "@/associations/catalog.service";
import { promotionService } from "./service";
import {
  promotion_scope_targets,
  promotions,
  type PromotionRow,
  type PromotionScope,
  type PromotionScopeTargetRow,
} from "./schema";

/**
 * Expand a product's DIRECT category ids to include every LIVE ANCESTOR, so a
 * category-scoped promotion set on a PARENT category applies to products in its
 * subcategories — matching how the storefront category page lists a parent's
 * whole subtree (listProductIdsInCategoryTree) and the schema's documented
 * "cascades to children" contract. Used ONLY for promo MATCHING (auto + coupon),
 * never for the non-discountable opt-out, which stays on the direct links.
 */
async function expandCategoryIdsWithAncestors(categoryIds: string[]): Promise<string[]> {
  if (categoryIds.length === 0) return categoryIds;
  const chains = await loadCategoryChains(categoryIds);
  const out = new Set<string>(categoryIds);
  for (const cid of categoryIds) for (const anc of chains.get(cid) ?? []) out.add(anc.id);
  return [...out];
}

/** Batch form of {@link expandCategoryIdsWithAncestors}: expand every product's
 *  category ids with ancestors in ONE chain load (keeps the batched promo path
 *  from doing an ancestor lookup per product). */
async function expandProductCategoryIds(
  catByProduct: Map<string, string[]>,
): Promise<Map<string, string[]>> {
  const all = new Set<string>();
  for (const ids of catByProduct.values()) for (const id of ids) all.add(id);
  if (all.size === 0) return catByProduct;
  const chains = await loadCategoryChains(all);
  const out = new Map<string, string[]>();
  for (const [pid, ids] of catByProduct) {
    const set = new Set<string>(ids);
    for (const cid of ids) for (const anc of chains.get(cid) ?? []) set.add(anc.id);
    out.set(pid, [...set]);
  }
  return out;
}

// ─────────────────── multi-target scope: the uniform matching contract ──────
/**
 * A promotion's EFFECTIVE product-set target. Resolved uniformly from a promo's
 * `promotion_scope_targets` rows (migration 0170 — a promo can target MANY
 * products / categories / brands) OR, for a legacy single-scope promo with no
 * rows, synthesised from its (scope, scope_id). This is the SINGLE matching
 * contract shared by the auto resolver (batch + per-product PDP paths), the
 * coupon-scope matcher, and the card/feed discount map — so a targeted promo
 * discounts the SAME lines everywhere, to the millime.
 */
type EffScopeTarget = {
  type: "product" | "category" | "brand";
  id: string;
  /** Categories only: also match the entity's SUBcategory products (the cascade). */
  cascade: boolean;
  /** Products only (migration 0173): NULL = all variants; set = ONLY that variant.
   *  FAIL-CLOSED — a variant-constrained target matches a line only when the line's
   *  variant is known AND equal (see productMatchesEffTargets / rowsForLineVariant). */
  variantId: string | null;
};

/**
 * The uniform product-set targets for a promo. Prefers its scope_targets rows;
 * falls back to synthesising ONE target from the legacy (scope, scope_id) when a
 * promo has no rows (a pre-0170 row the backfill missed, or a caller that didn't
 * load them). 'cart' — and a 'targeted' promo with no rows — yield NONE (no
 * specific products). Category targets cascade to subcategory products when
 * `include_descendants` (always true for a synthesised legacy category, matching
 * the established behaviour); product/brand never cascade.
 */
export function effectiveScopeTargets(
  promo: Pick<PromotionRow, "scope" | "scope_id">,
  targetRows: PromotionScopeTargetRow[] | undefined,
): EffScopeTarget[] {
  if (targetRows && targetRows.length > 0) {
    return targetRows.map((t) => ({
      type: t.target_type as EffScopeTarget["type"],
      id: t.target_id,
      cascade: t.target_type === "category" ? t.include_descendants : false,
      // variant_id is meaningful only on a product target (CHECK-enforced).
      variantId: t.target_type === "product" ? (t.variant_id ?? null) : null,
    }));
  }
  if (promo.scope !== "cart" && promo.scope !== "targeted" && promo.scope_id) {
    return [
      {
        type: promo.scope as EffScopeTarget["type"],
        id: promo.scope_id,
        cascade: promo.scope === "category",
        // A legacy single-scope product promo = ALL variants (byte-identical to pre-0173).
        variantId: null,
      },
    ];
  }
  return [];
}

/**
 * Does a product match ANY of a promo's effective targets? A category target
 * matches the product's ANCESTOR-expanded category ids when it cascades, and its
 * DIRECT category ids otherwise. Brand matches any of the product's brand ids.
 */
function productMatchesEffTargets(
  eff: EffScopeTarget[],
  facts: {
    productId: string;
    directCategoryIds: Set<string>;
    expandedCategoryIds: Set<string>;
    brandIds: Set<string>;
    /** The LINE's variant (migration 0173). Omitted/null ⇒ a variant-constrained
     *  product target does NOT match (fail-closed — never spread to all variants). */
    variantId?: string | null;
  },
): boolean {
  for (const t of eff) {
    if (t.type === "product") {
      // A product target matches when it names this product AND either covers all
      // variants (variantId null) or the line's variant equals the target's.
      if (t.id === facts.productId && (t.variantId == null || t.variantId === (facts.variantId ?? null))) {
        return true;
      }
    } else if (t.type === "brand") {
      if (facts.brandIds.has(t.id)) return true;
    } else if (t.cascade ? facts.expandedCategoryIds.has(t.id) : facts.directCategoryIds.has(t.id)) {
      return true;
    }
  }
  return false;
}

/**
 * Public read surface for the promotion module.
 *
 * Storefront pages and admin lists go through this barrel rather than
 * touching the service directly — keeps the module boundary clean and
 * lets the service add transactional reads / aggregations without
 * leaking implementation details.
 */

// The pure discount-math engine (computeProductDiscount / resolveProductDiscount)
// lives in a db-free module so it can be unit-tested without the server-only/db
// chain. Re-exported here AND via the module barrel, so the 7 existing callers
// (place-order, cart pricing, search, PDP, build-line-snapshot, …) keep
// importing from @/modules/promotion unchanged.
import {
  computeProductDiscount,
  resolveProductDiscount,
  type ProductDiscount,
} from "@/lib/promotions/product-discount";

export {
  computeProductDiscount,
  resolveProductDiscount,
  type ProductDiscount,
};

/**
 * Storefront helper: given a product id + its category/brand ancestor ids,
 * return the discount that should drive the price display on the PDP and
 * cards. Resolves auto-promotions only — coupon/url promos require an
 * explicit code or cookie and are handled by the cart layer.
 */
export async function getActiveDiscountForProduct(opts: {
  productId: string;
  unitPriceCents: number;
  categoryIds: string[];
  brandIds: string[];
  /** The LINE's variant (migration 0173). When set, a variant-constrained promo
   *  applies only if it targets this variant. Omitted (a simple product, or a
   *  caller that can't supply it) ⇒ variant-constrained promos are excluded
   *  (fail-closed) — pass it on the per-variant paths so variant promos resolve. */
  variantId?: string | null;
}): Promise<ProductDiscount | null> {
  // Global "never discountable" guard — short-circuits ALL promotion resolution
  // (auto-promo, and by extension the baked cart price / coin redemption) so a
  // flagged product or category is never reduced, no matter what.
  if (!(await productIsDiscountable(opts.productId, opts.categoryIds, opts.brandIds))) return null;

  // Load every live auto promo + its scope targets and match this product through
  // the SAME uniform contract the batched resolver uses (effectiveScopeTargets +
  // productMatchesEffTargets), so a MULTI-target promo (scope='targeted') and a
  // legacy single-scope one resolve identically here and at checkout. Match
  // categories against the product's cats AND their ANCESTORS for a cascading
  // (parent-scope) promo; the non-discountable guard above stays on DIRECT links.
  const [livePromos, expandedCategoryIds] = await Promise.all([
    promotionService.listLiveAutoPromotions(),
    expandCategoryIdsWithAncestors(opts.categoryIds),
  ]);
  if (livePromos.length === 0) return null;
  const scopeTargetsByPromo = await promotionService.listScopeTargetsForPromotions(
    livePromos.map((p) => p.id),
  );
  const facts = {
    productId: opts.productId,
    directCategoryIds: new Set(opts.categoryIds),
    expandedCategoryIds: new Set(expandedCategoryIds),
    brandIds: new Set(opts.brandIds),
    variantId: opts.variantId ?? null,
  };
  // Same ORDER BY as the batched path (display_priority DESC, created_at ASC) so
  // resolveProductDiscount's head-wins / stacked-compound pick is identical.
  const rows = livePromos
    .filter((p) => productMatchesEffTargets(effectiveScopeTargets(p, scopeTargetsByPromo.get(p.id)), facts))
    .sort(
      (a, b) =>
        b.display_priority - a.display_priority || a.created_at.getTime() - b.created_at.getTime(),
    );
  return resolveProductDiscount(opts.unitPriceCents, rows);
}

/**
 * BATCHED counterpart to {@link getActiveDiscountForProduct}: for a set of
 * product ids, resolve the live auto-promotion rows that apply to EACH product
 * in a fixed, small number of queries (4) instead of the ~4–5 per product the
 * per-line path costs. Returns a Map keyed by product id whose value carries:
 *   - `discountable`: false ⇒ the product is globally non-discountable (its own
 *     flag or a flagged category), so callers leave the price untouched.
 *   - `rows`: the matching live auto-promotions, ordered EXACTLY as
 *     `listLiveAutoForProduct` returns them (display_priority DESC, created_at
 *     ASC), so feeding them to `resolveProductDiscount` reproduces the per-line
 *     price to the millime — including stacked-promotion compounding.
 *
 * The caller still applies `resolveProductDiscount(lineBaseUnitPrice, rows)` per
 * LINE so a variant's own base price (which differs from the parent product's,
 * and can differ between two cart lines sharing a product) is honoured.
 *
 * Products absent from the map (no links / no matching promo) carry no
 * discount — the caller keeps the base unit price.
 */
export async function resolveLivePromotionRowsForProducts(
  productIds: string[],
): Promise<Map<string, LivePromoEntry>> {
  const out = new Map<string, LivePromoEntry>();
  const ids = Array.from(new Set(productIds));
  if (ids.length === 0) return out;

  // Four batched reads, independent of product count:
  //   1. all category links per product   2. brand id per product
  //   3. every live AUTO promotion         4. the non-discountable subset
  const [categoryIdsByProduct, brandIdByProduct, livePromos, blockedIds] =
    await Promise.all([
      productCategoryLinks.categoryIdsForProducts(ids),
      productBrandLink.findBrandIdsForProducts(ids),
      promotionService.listLiveAutoPromotions(),
      listNonDiscountableProductIds(ids),
    ]);
  const blocked = new Set(blockedIds);
  // Cascade: a category-scope promo on a PARENT applies to products in its
  // subcategories — match against each product's categories + LIVE ancestors.
  const categoryIdsByProductExpanded = await expandProductCategoryIds(categoryIdsByProduct);

  // Uniform product-set targets for every live auto promo — its scope_targets
  // rows (a MULTI-target promo, scope='targeted') OR a synthesised legacy target
  // (product/category/brand). One extra batched read, independent of product count.
  const scopeTargetsByPromo = await promotionService.listScopeTargetsForPromotions(
    livePromos.map((p) => p.id),
  );

  // Pre-bucket live auto-promotions by EFFECTIVE target so the per-product filter
  // is O(1) lookups rather than a full scan of every promo per product. A promo
  // with several targets lands in several buckets (deduped per product below).
  // Categories split into cascade (match ancestor-expanded ids) vs direct. Product
  // targets carry their variant constraint (null = all variants).
  const productScoped = new Map<string, Array<{ promo: PromotionRow; variantId: string | null }>>();
  const categoryCascade = new Map<string, PromotionRow[]>();
  const categoryDirect = new Map<string, PromotionRow[]>();
  const brandScoped = new Map<string, PromotionRow[]>();
  const push = (m: Map<string, PromotionRow[]>, key: string, p: PromotionRow) => {
    const arr = m.get(key);
    if (arr) arr.push(p);
    else m.set(key, [p]);
  };
  for (const p of livePromos) {
    for (const t of effectiveScopeTargets(p, scopeTargetsByPromo.get(p.id))) {
      if (t.type === "product") {
        const arr = productScoped.get(t.id);
        const entry = { promo: p, variantId: t.variantId };
        if (arr) arr.push(entry);
        else productScoped.set(t.id, [entry]);
      } else if (t.type === "brand") push(brandScoped, t.id, p);
      else push(t.cascade ? categoryCascade : categoryDirect, t.id, p);
    }
  }

  for (const id of ids) {
    if (blocked.has(id)) {
      out.set(id, { discountable: false, rows: [] });
      continue;
    }
    const directCats = categoryIdsByProduct.get(id) ?? [];
    const expandedCats = categoryIdsByProductExpanded.get(id) ?? [];
    const brandId = brandIdByProduct.get(id);

    // Reproduce the uniform match, split by variant constraint (migration 0173):
    //   unconstrained = matched via brand / category / a product target with NO
    //     variant → applies to ALL the product's variants (goes in `rows`);
    //   byVariant[V] = matched ONLY via a product target constrained to variant V →
    //     applies to that variant ALONE (goes in `rowsByVariant`, never `rows`).
    // De-dupe by promo id. FAIL-CLOSED: a variant-constrained promo is kept OUT of
    // the default `rows`, so a caller that ignores rowsByVariant never over-discounts.
    const unconstrained = new Map<string, PromotionRow>();
    const byVariant = new Map<string, Map<string, PromotionRow>>();
    for (const e of productScoped.get(id) ?? []) {
      if (e.variantId == null) {
        unconstrained.set(e.promo.id, e.promo);
      } else {
        let m = byVariant.get(e.variantId);
        if (!m) { m = new Map(); byVariant.set(e.variantId, m); }
        m.set(e.promo.id, e.promo);
      }
    }
    if (brandId) {
      for (const p of brandScoped.get(brandId) ?? []) unconstrained.set(p.id, p);
    }
    for (const cid of expandedCats) {
      for (const p of categoryCascade.get(cid) ?? []) unconstrained.set(p.id, p);
    }
    for (const cid of directCats) {
      for (const p of categoryDirect.get(cid) ?? []) unconstrained.set(p.id, p);
    }
    // A promo matched via ANY unconstrained target covers all variants — drop it
    // from the per-variant buckets (the unconstrained match wins).
    if (unconstrained.size > 0) {
      for (const m of byVariant.values()) for (const pid of unconstrained.keys()) m.delete(pid);
    }

    // Same ORDER BY as the per-product path (display_priority DESC, then created_at
    // ASC) so resolveProductDiscount's head-wins / headline pick is identical.
    const rows = sortPromoRows([...unconstrained.values()]);
    let rowsByVariant: Map<string, PromotionRow[]> | undefined;
    for (const [vid, m] of byVariant) {
      if (m.size === 0) continue;
      if (!rowsByVariant) rowsByVariant = new Map();
      rowsByVariant.set(vid, sortPromoRows([...m.values()]));
    }
    out.set(id, { discountable: true, rows, ...(rowsByVariant ? { rowsByVariant } : {}) });
  }

  return out;
}

/** The head-wins / stacked-compound tiebreak shared by the resolver + rowsForLineVariant. */
function sortPromoRows(rows: PromotionRow[]): PromotionRow[] {
  return rows.sort(
    (a, b) =>
      b.display_priority - a.display_priority || a.created_at.getTime() - b.created_at.getTime(),
  );
}

/** A product's live auto-promotion set from {@link resolveLivePromotionRowsForProducts}:
 *  `rows` = the promos that apply to ALL variants; `rowsByVariant` = promos constrained
 *  to a specific variant (migration 0173). Feed a LINE through {@link rowsForLineVariant}. */
export type LivePromoEntry = {
  discountable: boolean;
  rows: PromotionRow[];
  rowsByVariant?: Map<string, PromotionRow[]>;
};

/**
 * The rows a specific cart/order LINE should be priced against: the product's
 * all-variant promos PLUS any promos constrained to the line's variant, re-merged in
 * the canonical order. FAIL-CLOSED — with an unknown variant (null), only the
 * all-variant `rows` are returned, so a variant-constrained promo can NEVER discount a
 * line whose variant we can't confirm. Pure (no DB); resolveProductDiscount is unchanged.
 */
export function rowsForLineVariant(
  entry: LivePromoEntry | undefined,
  variantId: string | null,
): PromotionRow[] {
  if (!entry) return [];
  if (variantId == null || !entry.rowsByVariant) return entry.rows;
  const extra = entry.rowsByVariant.get(variantId);
  if (!extra || extra.length === 0) return entry.rows;
  // `rows` (unconstrained) and `extra` (this variant) are disjoint by promo id.
  return sortPromoRows([...entry.rows, ...extra]);
}

/**
 * Which of `productIds` a SCOPED coupon (scope = product/category/brand) applies
 * to. Reproduces EXACTLY the per-product match `resolveLivePromotionRowsForProducts`
 * uses for auto promos — this product directly, or any of its category links, or
 * its brand — so a scoped CODE coupon discounts the same lines an equivalent auto
 * promo would. Globally non-discountable products (own flag or a flagged category)
 * are excluded, mirroring `getActiveDiscountForProduct`'s "never reductable" guard
 * so a code can't override that opt-out. `cart` scope returns the empty set (it
 * isn't line-scoped — the caller discounts the whole subtotal instead).
 */
export async function productsMatchingScope(
  scope: PromotionScope,
  scopeId: string | null,
  productIds: string[],
): Promise<Set<string>> {
  // Legacy single-scope: synthesise one effective target from (scope, scope_id)
  // and match through the SHARED contract (cart / no scopeId → no targets → empty).
  return matchProductIdsToEffTargets(
    effectiveScopeTargets({ scope, scope_id: scopeId }, undefined),
    productIds,
  );
}

/**
 * Promo-aware counterpart used by the coupon engine: which of `productIds` a
 * coupon applies to given its FULL product set — a MULTI-target coupon
 * (scope='targeted') matches ANY of its scope_targets; a legacy single-scope one
 * matches its synthesised target. Identical matching to the auto path, so a
 * scoped CODE coupon discounts the same lines an equivalent auto promo would.
 * `cart` scope → empty (the caller discounts the whole subtotal instead).
 */
export async function productsMatchingPromoScope(
  promo: Pick<PromotionRow, "id" | "scope" | "scope_id">,
  productIds: string[],
): Promise<Set<string>> {
  const targetRows = (await promotionService.listScopeTargetsForPromotions([promo.id])).get(promo.id);
  return matchProductIdsToEffTargets(effectiveScopeTargets(promo, targetRows), productIds);
}

/**
 * Which of `productIds` match ANY of a resolved set of effective targets — the
 * shared primitive behind `productsMatchingScope` (legacy) and
 * `productsMatchingPromoScope` (multi-target). Honours the global non-discountable
 * opt-out (a code can't discount a flagged product / category / brand) and only
 * loads the link dimensions the targets actually reference. Empty targets → empty.
 */
async function matchProductIdsToEffTargets(
  eff: EffScopeTarget[],
  productIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  const ids = Array.from(new Set(productIds));
  if (ids.length === 0 || eff.length === 0) return out;

  const blocked = new Set(await listNonDiscountableProductIds(ids));
  const eligible = ids.filter((id) => !blocked.has(id));
  if (eligible.length === 0) return out;

  const needCategory = eff.some((t) => t.type === "category");
  const needBrand = eff.some((t) => t.type === "brand");
  const [directCatByProduct, brandByProduct] = await Promise.all([
    needCategory
      ? productCategoryLinks.categoryIdsForProducts(eligible)
      : Promise.resolve(new Map<string, string[]>()),
    needBrand
      ? productBrandLink.findBrandIdsForProducts(eligible)
      : Promise.resolve(new Map<string, string>()),
  ]);
  const expandedCatByProduct = needCategory
    ? await expandProductCategoryIds(directCatByProduct)
    : new Map<string, string[]>();

  for (const id of eligible) {
    const brandId = brandByProduct.get(id);
    const facts = {
      productId: id,
      directCategoryIds: new Set(directCatByProduct.get(id) ?? []),
      expandedCategoryIds: new Set(expandedCatByProduct.get(id) ?? []),
      brandIds: new Set(brandId ? [brandId] : []),
    };
    if (productMatchesEffTargets(eff, facts)) out.add(id);
  }
  return out;
}

/**
 * True unless the product itself is flagged non-discountable OR it belongs to
 * any non-discountable category OR any non-discountable BRAND. The single source
 * of truth for the global "never reductable" opt-out. Module-local — the only
 * caller is `getActiveDiscountForProduct` below; external callers use
 * `listNonDiscountableProductIds`. Brands are FLAT, so the brand tier is a plain
 * direct-link check (no ancestor expansion).
 */
async function productIsDiscountable(
  productId: string,
  categoryIds: string[],
  brandIds: string[],
): Promise<boolean> {
  const [p] = await db
    .select({ d: products.is_discountable })
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);
  if (p && p.d === false) return false;
  if (categoryIds.length > 0) {
    const [c] = await db
      .select({ one: sql`1` })
      .from(categories)
      .where(
        and(
          inArray(categories.id, categoryIds),
          eq(categories.is_discountable, false),
          // A soft-deleted category keeps its product_categories links (the FK
          // only cascades on a hard delete) but must stop governing pricing —
          // its opt-out would otherwise keep blocking discounts invisibly.
          isNull(categories.deleted_at),
        ),
      )
      .limit(1);
    if (c) return false;
  }
  if (brandIds.length > 0) {
    const [b] = await db
      .select({ one: sql`1` })
      .from(brands)
      .where(
        and(
          inArray(brands.id, brandIds),
          eq(brands.is_discountable, false),
          // Same live-only rule as the category tier: a soft-deleted brand keeps
          // its product_brands link but must stop governing pricing.
          isNull(brands.deleted_at),
        ),
      )
      .limit(1);
    if (b) return false;
  }
  return true;
}

/**
 * Bulk variant of the guard: from the given product ids, return the subset that
 * must NEVER be discounted — flagged directly OR linked to a non-discountable
 * category OR a non-discountable BRAND. The showcase promo map expands promotion
 * SCOPES into product ids directly (bypassing getActiveDiscountForProduct), so it
 * re-applies the guard through this to strip flagged products from card pricing.
 */
export async function listNonDiscountableProductIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const blocked = new Set<string>();
  const direct = await db
    .select({ id: products.id })
    .from(products)
    .where(and(inArray(products.id, ids), eq(products.is_discountable, false)));
  for (const r of direct) blocked.add(r.id);
  const viaCategory = await db
    .select({ id: product_categories.product_id })
    .from(product_categories)
    .innerJoin(categories, eq(categories.id, product_categories.category_id))
    .where(
      and(
        inArray(product_categories.product_id, ids),
        eq(categories.is_discountable, false),
        // Same live-only rule as productIsDiscountable (soft-deleted categories
        // keep their links but no longer apply).
        isNull(categories.deleted_at),
      ),
    );
  for (const r of viaCategory) blocked.add(r.id);
  const viaBrand = await db
    .select({ id: product_brands.product_id })
    .from(product_brands)
    .innerJoin(brands, eq(brands.id, product_brands.brand_id))
    .where(
      and(
        inArray(product_brands.product_id, ids),
        eq(brands.is_discountable, false),
        // Live-only, same as the category tier (a soft-deleted brand keeps its link).
        isNull(brands.deleted_at),
      ),
    );
  for (const r of viaBrand) blocked.add(r.id);
  return [...blocked];
}

/**
 * How many promotions still TARGET a category / brand: scope = `scope` and
 * scope_id = `scopeId`, enabled (`is_active`), not deleted and not ended — a
 * scheduled one that hasn't started yet counts too, it would go live on its
 * own. Every trigger kind (auto, code, url) — a scoped coupon is as bound to
 * its target as an automatic promo. The category / brand DELETE workflows
 * refuse while this is > 0, so a deleted entity never keeps a promotion
 * silently pointing at it (the link readers ignore deleted targets anyway).
 */
export async function countLivePromotionsForScope(
  scope: "category" | "brand",
  scopeId: string,
): Promise<number> {
  // Count each live promo ONCE whether it points at the entity via the legacy
  // (scope, scope_id) OR a promotion_scope_targets row (a MULTI-target promo). A
  // backfilled legacy promo matches BOTH — the OR (not a sum) de-dupes it.
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(promotions)
    .where(
      and(
        eq(promotions.is_active, true),
        isNull(promotions.deleted_at),
        or(isNull(promotions.ends_at), gt(promotions.ends_at, sql`now()`)),
        or(
          and(eq(promotions.scope, scope), eq(promotions.scope_id, scopeId)),
          sql`EXISTS (SELECT 1 FROM ${promotion_scope_targets} st WHERE st.promotion_id = ${promotions.id} AND st.target_type = ${scope} AND st.target_id = ${scopeId}::uuid)`,
        ),
      ),
    );
  return Number(r?.n ?? 0);
}

/** Re-export the service for workflow use. */
export { promotionService };
