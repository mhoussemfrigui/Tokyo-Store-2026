import "server-only";

import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  product_variant_values,
  product_variants,
  products,
  type ProductRow,
  type ProductVariantRow,
} from "./schema";

/**
 * Reads. These are the only thing pages should import from this module —
 * mutations go through workflows.
 */

export async function listPublishedProducts(
  opts: { limit?: number; offset?: number } = {},
): Promise<ProductRow[]> {
  return db
    .select()
    .from(products)
    .where(and(eq(products.is_published, true), isNull(products.deleted_at)))
    // DESC NULLS LAST to ride `products_published_recent_idx`
    // (is_published, published_at DESC NULLS LAST) WHERE deleted_at IS NULL —
    // Drizzle's desc() emits DESC NULLS FIRST, which that index can't serve, so
    // the planner would fall back to a full scan + sort. desc(id) (uuid v7, so
    // time-ordered) is a deterministic tiebreaker for stable offset pagination.
    .orderBy(sql`${products.published_at} desc nulls last`, desc(products.id))
    .limit(Math.min(opts.limit ?? 24, 100))
    .offset(Math.max(opts.offset ?? 0, 0));
}

/**
 * Slug + indexing (noindex / canonical) + date columns ONLY — for the sitemap. Avoids the full
 * media/category/variant/promo enrich pipeline (`mapAndEnrichRows`) just to emit
 * `url` + `lastmod`, and (unlike `listPublishedProducts`' 100 cap) returns the
 * WHOLE published catalog so a store with >100 SKUs isn't silently under-indexed.
 * Index-backed (`products_published_recent_idx`, partial WHERE deleted_at IS NULL,
 * published_at DESC NULLS LAST — the ORDER BY below matches it exactly).
 */
export async function listPublishedProductSlugs(
  limit = 50000,
): Promise<
  Array<{
    slug: string;
    noindex: boolean;
    canonical_url: string | null;
    updated_at: Date | null;
    published_at: Date | null;
  }>
> {
  return db
    .select({
      slug: products.slug,
      noindex: products.noindex,
      // The sitemap skips a product whose canonical override points elsewhere
      // (a variant / duplicate folded onto a master URL) — see sitemap.ts.
      canonical_url: products.canonical_url,
      updated_at: products.updated_at,
      published_at: products.published_at,
    })
    .from(products)
    .where(and(eq(products.is_published, true), isNull(products.deleted_at)))
    // DESC NULLS LAST matches products_published_recent_idx (see doc above);
    // desc() alone emits NULLS FIRST and forces a 50k-row sort off-index.
    .orderBy(sql`${products.published_at} desc nulls last`)
    .limit(limit);
}

export async function getProductBySlug(slug: string): Promise<ProductRow | null> {
  const [row] = await db
    .select()
    .from(products)
    .where(and(eq(products.slug, slug), isNull(products.deleted_at)))
    .limit(1);
  return row ?? null;
}

export async function listProductsByIds(ids: string[]): Promise<ProductRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(products)
    .where(and(inArray(products.id, ids), isNull(products.deleted_at)));
}

/**
 * The PUBLISHED, live ids among `ids`, newest first (published_at DESC NULLS
 * LAST, id DESC — the listing index order) — the deterministic order the
 * storefront grids cap (MAX_GRID_PRODUCTS) and render in. `ids` is a raw
 * link-table set (duplicates / drafts / soft-deleted rows allowed); it's bound as
 * ONE uuid[] parameter, so an arbitrarily large set never hits the protocol's
 * bind-parameter limit (the cap applies AFTER this filter + order).
 */
export async function listPublishedIdsNewestFirst(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(
      and(
        sql`${products.id} = any(${sql.param(ids)}::uuid[])`,
        eq(products.is_published, true),
        isNull(products.deleted_at),
      ),
    )
    .orderBy(sql`${products.published_at} desc nulls last`, desc(products.id));
  return rows.map((r) => r.id);
}

/**
 * Published, live products whose LISTING CARD shows a compare-at markdown — the
 * catalogue-wide « compare-at » pool of the /promotions showcase and the home
 * promotions rail (it used to be a filter over the newest-100 slice, so an older
 * marked-down product never surfaced). « The card's » pair mirrors the catalog
 * mapper (lib/listing/display-pricing.ts `listingDisplayPricing`): a VARIABLE
 * product with live variants shows its CHEAPEST variant (price ASC, then display
 * order) — its price + compare-at; every other product its own row. Qualifies
 * when that compare-at is strictly above that price.
 *
 * `order: "deal"` (default) = strongest markdown first, then newest; "recent" =
 * newest first. Bounded by `limit` (≤ 500); the caller caps the final list. The
 * correlated variant sub-selects run only for variable rows (CASE is lazy), a
 * negligible cost at this catalogue's scale; add a partial index on
 * (old_price_cents > price_cents) only if EXPLAIN ever shows the need.
 */
export async function listPublishedCompareAtProducts(
  opts: { limit?: number; order?: "deal" | "recent" } = {},
): Promise<ProductRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 300) || 300, 1), 500);
  const hasLiveVariant = sql`exists (select 1 from product_variants pv where pv.product_id = ${products.id} and pv.deleted_at is null)`;
  const cheapestVariantCol = (col: "price_cents" | "old_price_cents") =>
    sql`(select pv.${sql.raw(col)} from product_variants pv where pv.product_id = ${products.id} and pv.deleted_at is null order by pv.price_cents asc, pv.display_order asc, pv.created_at asc, pv.id asc limit 1)`;
  const isVariantPriced = sql`(${products.product_type} = 'variable' and ${hasLiveVariant})`;
  const displayPrice = sql`(case when ${isVariantPriced} then ${cheapestVariantCol("price_cents")} else ${products.price_cents} end)`;
  const displayOld = sql`(case when ${isVariantPriced} then ${cheapestVariantCol("old_price_cents")} else ${products.old_price_cents} end)`;
  const recency = [sql`${products.published_at} desc nulls last`, desc(products.id)];
  return db
    .select()
    .from(products)
    .where(
      and(
        eq(products.is_published, true),
        isNull(products.deleted_at),
        sql`${displayOld} > ${displayPrice}`,
      ),
    )
    .orderBy(
      ...(opts.order === "recent"
        ? recency
        : [sql`(1 - ${displayPrice}::float8 / nullif(${displayOld}, 0)) desc`, ...recency]),
    )
    .limit(limit);
}

/**
 * Like `listProductsByIds` but keyed by slug. Used by the category page to
 * recover product IDs from the storefront-mapped DTOs (written before the DTO
 * carried `id`) without over-fetching the whole published list.
 */
export async function listProductsBySlugs(slugs: string[]): Promise<ProductRow[]> {
  if (slugs.length === 0) return [];
  return db
    .select()
    .from(products)
    .where(and(inArray(products.slug, slugs), isNull(products.deleted_at)));
}

/** A stock-page filter state (the « Stock » tab chips + `?filter=`). */
export type StockState = "in_stock" | "low" | "out_of_stock" | "none";

/**
 * Stock-state SQL predicates over the PRODUCT-LEVEL pool — the ONE definition
 * shared by the stock page filters (`productService.listStockPaged`) and the
 * dashboard « Stock faible » card (`listLowStockProducts` / `countStockProducts`),
 * so a dashboard count always equals what its « Tout voir » link lists. JS twins
 * (badges / pills): `isEffectivelyOutOfStock` / `isLowStock` in
 * lib/inventory/stock-state.ts.
 *   - in_stock     : in_stock AND (untracked OR qty > 0) — what the storefront sells;
 *   - out_of_stock : its exact complement — NOT in_stock OR a TRACKED qty ≤ 0
 *                    (a qty-0 line left « Disponible » is unbuyable, so it is
 *                    « Rupture », not invisible to both filters);
 *   - low          : sellable with a tracked qty in [1, lowThreshold] — the
 *                    operator's `stock.low_threshold_qty` (resolveLowStockConfig);
 *                    a threshold ≤ 0 disables the tier (matches no row);
 *   - none         : untracked (stock_qty IS NULL).
 */
export function stockStateSql(state: StockState, lowThreshold: number): SQL {
  switch (state) {
    case "in_stock":
      return sql`(${products.in_stock} = true and (${products.stock_qty} is null or ${products.stock_qty} > 0))`;
    case "out_of_stock":
      return sql`(${products.in_stock} = false or ${products.stock_qty} <= 0)`;
    case "low":
      return sql`(${products.in_stock} = true and ${products.stock_qty} between 1 and ${Math.max(0, Math.trunc(lowThreshold))})`;
    case "none":
      return sql`(${products.stock_qty} is null)`;
  }
}

/**
 * Low-stock products — the admin dashboard « Stock faible » card rows: the SAME
 * `low` predicate (and configured threshold) as the stock page's `?filter=low`,
 * over every live product (published or not, exactly like that page), soonest
 * to run out first. Product-level pool only — good enough for an at-a-glance
 * alert; per-variant depletion is surfaced on the product page itself. The card
 * shows the TRUE total via `countStockProducts("low", …)`, not this capped list.
 */
export async function listLowStockProducts(
  opts: { threshold?: number; limit?: number } = {},
): Promise<Array<{ id: string; name: string; slug: string; stock_qty: number }>> {
  const threshold = Math.max(0, opts.threshold ?? 5);
  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      stock_qty: products.stock_qty,
    })
    .from(products)
    .where(and(isNull(products.deleted_at), stockStateSql("low", threshold)))
    .orderBy(asc(products.stock_qty), asc(products.name))
    .limit(Math.min(opts.limit ?? 5, 20));
  // stock_qty is non-null by the WHERE filter; coalesce only to satisfy the type.
  return rows.map((r) => ({ ...r, stock_qty: r.stock_qty ?? 0 }));
}

/** TRUE count of live products in a stock state — same predicate + threshold as
 *  the stock page filter (the dashboard badges link there). */
export async function countStockProducts(state: StockState, lowThreshold: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(products)
    .where(and(isNull(products.deleted_at), stockStateSql(state, lowThreshold)));
  return Number(row?.n ?? 0);
}

// ─── Variants ─────────────────────────────────────────────────────────────

/** Live (non-deleted) variants of a product, ordered for display. */
export async function listVariantsForProduct(productId: string): Promise<ProductVariantRow[]> {
  return db
    .select()
    .from(product_variants)
    .where(and(eq(product_variants.product_id, productId), isNull(product_variants.deleted_at)))
    .orderBy(asc(product_variants.display_order), asc(product_variants.created_at));
}

/** Batch variant load keyed by product id — used by the catalog mapper. */
export async function listVariantsForProducts(
  productIds: string[],
): Promise<Map<string, ProductVariantRow[]>> {
  const map = new Map<string, ProductVariantRow[]>();
  if (productIds.length === 0) return map;
  const rows = await db
    .select()
    .from(product_variants)
    .where(
      and(inArray(product_variants.product_id, productIds), isNull(product_variants.deleted_at)),
    )
    .orderBy(asc(product_variants.display_order), asc(product_variants.created_at));
  for (const r of rows) {
    const list = map.get(r.product_id);
    if (list) list.push(r);
    else map.set(r.product_id, [r]);
  }
  return map;
}

/**
 * The attribute-value ids that define each variant, keyed by variant id.
 * e.g. a "Rouge / 512 Go" variant maps to ["<red-id>", "<512-id>"].
 */
export async function listVariantValueLinks(
  variantIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (variantIds.length === 0) return map;
  const rows = await db
    .select({
      variant_id: product_variant_values.variant_id,
      attribute_value_id: product_variant_values.attribute_value_id,
    })
    .from(product_variant_values)
    .where(inArray(product_variant_values.variant_id, variantIds));
  for (const r of rows) {
    const list = map.get(r.variant_id);
    if (list) list.push(r.attribute_value_id);
    else map.set(r.variant_id, [r.attribute_value_id]);
  }
  return map;
}

/**
 * How many LIVE variants are defined by any of the given attribute value ids.
 * Backs the "block deletion when in use" guard for attribute values /
 * attributes — a hard-delete of a value cascades product_variant_values and
 * silently strips the value from those variants' combos, so we refuse when the
 * count is > 0. Soft-deleted variants don't count (they're already gone).
 */
export async function countLiveVariantsUsingValues(valueIds: string[]): Promise<number> {
  if (valueIds.length === 0) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(distinct ${product_variant_values.variant_id})::int` })
    .from(product_variant_values)
    .innerJoin(
      product_variants,
      and(
        eq(product_variants.id, product_variant_values.variant_id),
        isNull(product_variants.deleted_at),
      ),
    )
    .where(inArray(product_variant_values.attribute_value_id, valueIds));
  return Number(row?.n ?? 0);
}

/** Single live variant by id — used at add-to-cart / checkout to price it. */
export async function findVariantById(id: string): Promise<ProductVariantRow | null> {
  const [row] = await db
    .select()
    .from(product_variants)
    .where(and(eq(product_variants.id, id), isNull(product_variants.deleted_at)))
    .limit(1);
  return row ?? null;
}

/** Single live variant by SKU (unique among live variants) — for the stock API. */
export async function findVariantBySku(sku: string): Promise<ProductVariantRow | null> {
  const [row] = await db
    .select()
    .from(product_variants)
    .where(and(eq(product_variants.sku, sku), isNull(product_variants.deleted_at)))
    .limit(1);
  return row ?? null;
}

// ── Précommandes queue (the /admin/catalog/preorders page) ───────────────────

/** How long a just-released preorder lingers in the « Récemment sorties » bucket. */
export const RECENTLY_RELEASED_DEFAULT_DAYS = 21;

export type PreorderQueueRow = {
  id: string;
  slug: string;
  name: string;
  price_cents: number;
  preorder_releases_at: Date | null;
  is_published: boolean;
};

const PREORDER_QUEUE_COLS = {
  id: products.id,
  slug: products.slug,
  name: products.name,
  price_cents: products.price_cents,
  preorder_releases_at: products.preorder_releases_at,
  is_published: products.is_published,
};

/** Live products flagged `is_preorder` — the queue. Soonest release first
 *  (undated last). Partial `products_preorder_idx` serves the filter. */
export async function listPreorderQueue(opts: { limit?: number } = {}): Promise<PreorderQueueRow[]> {
  return db
    .select(PREORDER_QUEUE_COLS)
    .from(products)
    .where(and(eq(products.is_preorder, true), isNull(products.deleted_at)))
    .orderBy(sql`${products.preorder_releases_at} asc nulls last`, desc(products.id))
    .limit(Math.min(opts.limit ?? 500, 1000));
}

export async function countPreorderQueue(): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(products)
    .where(and(eq(products.is_preorder, true), isNull(products.deleted_at)));
  return row?.n ?? 0;
}

const recentlyReleasedWhere = (days: number) =>
  and(
    isNull(products.deleted_at),
    isNotNull(products.preorder_releases_at),
    sql`${products.preorder_releases_at} <= now()`,
    sql`${products.preorder_releases_at} >= now() - make_interval(days => ${days}::int)`,
  );

/** Products whose release date fell within the last N days — kept visible after
 *  launch so an operator can still track their orders. Independent of the
 *  is_preorder flag (catches rows already swept back to a normal sale). */
export async function listRecentlyReleasedPreorders(
  opts: { limit?: number; days?: number } = {},
): Promise<PreorderQueueRow[]> {
  const days = opts.days ?? RECENTLY_RELEASED_DEFAULT_DAYS;
  return db
    .select(PREORDER_QUEUE_COLS)
    .from(products)
    .where(recentlyReleasedWhere(days))
    .orderBy(sql`${products.preorder_releases_at} desc nulls last`, desc(products.id))
    .limit(Math.min(opts.limit ?? 500, 1000));
}

export async function countRecentlyReleasedPreorders(
  days = RECENTLY_RELEASED_DEFAULT_DAYS,
): Promise<number> {
  const [row] = await db.select({ n: count() }).from(products).where(recentlyReleasedWhere(days));
  return row?.n ?? 0;
}
