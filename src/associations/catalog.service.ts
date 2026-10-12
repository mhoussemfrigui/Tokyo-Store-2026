import "server-only";

import { and, asc, desc, eq, getTableColumns, inArray, isNull, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { isUuid } from "@/lib/utils/uuid";
import { brands } from "@/modules/catalog/brand/schema";
import { categories } from "@/modules/catalog/category/schema";
import { products } from "@/modules/catalog/product/schema";
import { product_brands } from "./product-brand";
import { product_categories } from "./product-category";
import { product_media, type ProductMediaRow } from "./product-media";
import { product_related } from "./product-related";
import { product_complementary } from "./product-complementary";

/**
 * Helpers that span the catalog associations.
 * Workflows use these to wire products to categories/brand/media inside
 * a transaction.
 */

export const productCategoryLinks = {
  async set(
    productId: string,
    categoryIds: string[],
    primaryId?: string,
    txOrDb: DbOrTx = db,
  ) {
    await txOrDb.transaction(async (tx) => {
      await tx
        .delete(product_categories)
        .where(eq(product_categories.product_id, productId));
      if (categoryIds.length === 0) return;
      await tx.insert(product_categories).values(
        categoryIds.map((cid) => ({
          product_id: productId,
          category_id: cid,
          is_primary: primaryId === cid,
        })),
      );
    });
  },

  /**
   * A product's category links — LIVE categories only. A soft-deleted category
   * keeps its product_categories rows (the FK only cascades on a hard delete) but
   * must stop governing anything: this feeds the PDP / add-to-cart promotion
   * match (which must agree with the cart's `categoryIdsForProducts`), the
   * breadcrumb, related products, duplication and the admin editor hydrate
   * (whose picker already dropped dead ids).
   */
  async listForProduct(productId: string) {
    return db
      .select(getTableColumns(product_categories))
      .from(product_categories)
      .innerJoin(categories, eq(categories.id, product_categories.category_id))
      .where(and(eq(product_categories.product_id, productId), isNull(categories.deleted_at)));
  },

  /**
   * Product ids DIRECTLY linked to a category — empty for a soft-deleted one, so
   * a legacy promotion still scoped to a deleted category stops discounting the
   * listing cards (parity with the cart's live-only `categoryIdsForProducts`).
   */
  async listProductIdsInCategory(categoryId: string): Promise<string[]> {
    const rows = await db
      .select({ pid: product_categories.product_id })
      .from(product_categories)
      .innerJoin(categories, eq(categories.id, product_categories.category_id))
      .where(and(eq(product_categories.category_id, categoryId), isNull(categories.deleted_at)));
    // product_id is uuid with an enforced FK, so rows are well-formed —
    // the isUuid filter is a cheap defensive guard for callers that bind
    // these ids as `uuid` against `products.id`.
    return rows.map((r) => r.pid).filter(isUuid);
  },

  /**
   * Like `listProductIdsInCategory`, but ROLLS UP descendants: resolves the
   * given category AND every category nested beneath it (any depth), then the
   * DISTINCT product ids linked to that whole subtree. Used by the admin
   * products list filter so picking a parent (e.g. "Montres Homme") surfaces
   * products filed only on its leaves (e.g. "Plongée").
   *
   * A recursive CTE walks `categories.parent_id`; both the anchor and the
   * recursive step skip soft-deleted rows (`deleted_at IS NULL`) so a
   * tombstoned branch contributes nothing. Bails out to `[]` on a malformed
   * id (no `::uuid` bind on a non-uuid) and filters the result through the
   * same `isUuid` guard as its single-node sibling.
   */
  async listProductIdsInCategoryTree(categoryId: string): Promise<string[]> {
    if (!isUuid(categoryId)) return [];
    // `depth` bounds the walk so a malformed parent_id CYCLE (the self-FK has
    // no DB-level cycle guard) can never spin forever — the tree is ≤4 levels
    // in practice, so 20 is generous insurance.
    const result = await db.execute<{ product_id: string }>(sql`
      WITH RECURSIVE sub AS (
        SELECT id, 1 AS depth FROM categories
          WHERE id = ${categoryId}::uuid AND deleted_at IS NULL
        UNION ALL
        SELECT c.id, sub.depth + 1 FROM categories c
          JOIN sub ON c.parent_id = sub.id
          WHERE c.deleted_at IS NULL AND sub.depth < 20
      )
      SELECT DISTINCT product_id
        FROM product_categories
        WHERE category_id IN (SELECT id FROM sub)
    `);
    return result.rows.map((r) => r.product_id).filter(isUuid);
  },

  /**
   * DB-paginated sibling of {@link listProductIdsInCategoryTree}: the ids of the
   * PUBLISHED, non-deleted products in a category subtree, ordered newest-first
   * (`published_at DESC`, `id` as a stable tiebreaker) and sliced to one page at
   * the DB. Used by the EXTERNAL `/api/products?category=` endpoint so it loads
   * + enriches only the requested page instead of the whole subtree.
   *
   * NOTE: this is intentionally NOT used by the storefront category page, which
   * needs the FULL set for faceted attribute filtering + client-side sort —
   * that path stays on `listProductIdsInCategoryTree`/`listProductsByCategory`.
   * The published filter lives HERE (unlike the unbounded tree fn, which filters
   * `is_published` after loading), so the page count is correct.
   */
  async listPublishedProductIdsInCategoryTreePaged(
    categoryId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<string[]> {
    if (!isUuid(categoryId)) return [];
    const limit = Math.min(Math.max(opts.limit ?? 24, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const result = await db.execute<{ id: string }>(sql`
      WITH RECURSIVE sub AS (
        SELECT id, 1 AS depth FROM categories
          WHERE id = ${categoryId}::uuid AND deleted_at IS NULL
        UNION ALL
        SELECT c.id, sub.depth + 1 FROM categories c
          JOIN sub ON c.parent_id = sub.id
          WHERE c.deleted_at IS NULL AND sub.depth < 20
      )
      SELECT p.id
        FROM products p
        WHERE p.deleted_at IS NULL AND p.is_published = true
          AND p.id IN (
            SELECT pc.product_id FROM product_categories pc
              WHERE pc.category_id IN (SELECT id FROM sub)
          )
        ORDER BY p.published_at DESC NULLS LAST, p.id DESC
        LIMIT ${limit} OFFSET ${offset}
    `);
    return result.rows.map((r) => r.id).filter(isUuid);
  },

  /**
   * Batched ROLL-UP product count: for each input category, the number of
   * DISTINCT published, non-deleted products anywhere in its subtree (the
   * category itself + every descendant, any depth). The storefront listing
   * (`listProductsByCategory`) rolls up descendants, so the "X produits"
   * badges / nav chips must roll up the SAME way or a parent would show 0 in
   * the nav while its page lists products.
   *
   * One recursive CTE handles all roots at once: it carries `root_id` down the
   * descent so each descendant's products are attributed back to the root they
   * came from. `COUNT(DISTINCT p.id)` de-dupes a product linked to several
   * categories within the same subtree. Categories with zero are omitted
   * (callers default to 0).
   */
  async countProductsForCategoryTrees(
    categoryIds: string[],
  ): Promise<Map<string, number>> {
    const roots = categoryIds.filter(isUuid);
    if (roots.length === 0) return new Map();
    const idList = sql.join(
      roots.map((r) => sql`${r}::uuid`),
      sql`, `,
    );
    // `depth` bounds the walk against a malformed parent_id cycle (see
    // listProductIdsInCategoryTree). The real tree is ≤4 levels deep.
    const result = await db.execute<{ root_id: string; cnt: number }>(sql`
      WITH RECURSIVE sub AS (
        SELECT id AS root_id, id AS cat_id, 1 AS depth FROM categories
          WHERE id IN (${idList}) AND deleted_at IS NULL
        UNION ALL
        SELECT s.root_id, c.id, s.depth + 1 FROM categories c
          JOIN sub s ON c.parent_id = s.cat_id
          WHERE c.deleted_at IS NULL AND s.depth < 20
      )
      SELECT s.root_id, COUNT(DISTINCT p.id)::int AS cnt
        FROM sub s
        JOIN product_categories pc ON pc.category_id = s.cat_id
        JOIN products p ON p.id = pc.product_id
          AND p.is_published = true AND p.deleted_at IS NULL
        GROUP BY s.root_id
    `);
    return new Map(result.rows.map((r) => [r.root_id, Number(r.cnt)]));
  },

  /**
   * Primary category id per product — one query for N products. Used by
   * `mapProductRows` to avoid the N+1 pattern on listing pages, and by the
   * order / cart / checkout TVA + warranty chain.
   *
   * LIVE categories only: a primary link pointing at a SOFT-deleted category
   * (a root delete keeps its links; older deletes kept them all) falls back to
   * the product's first other LIVE link (oldest first) instead of resolving to a
   * tombstone — which made the chain skip the category TVA / warranty entirely
   * (→ global rate) and blanked the storefront category. A product that never
   * had a primary link stays absent (unchanged behaviour).
   */
  async primaryCategoriesForProducts(productIds: string[]): Promise<Map<string, string>> {
    if (productIds.length === 0) return new Map();
    const rows = await db
      .select({
        pid: product_categories.product_id,
        cid: product_categories.category_id,
        isPrimary: product_categories.is_primary,
        live: sql<boolean>`${categories.deleted_at} is null`,
      })
      .from(product_categories)
      .innerJoin(categories, eq(categories.id, product_categories.category_id))
      .where(inArray(product_categories.product_id, productIds))
      .orderBy(asc(product_categories.created_at), asc(product_categories.id));
    const livePrimary = new Map<string, string>();
    const firstLive = new Map<string, string>();
    const deadPrimary = new Set<string>();
    for (const r of rows) {
      if (r.live) {
        if (r.isPrimary) livePrimary.set(r.pid, r.cid);
        if (!firstLive.has(r.pid)) firstLive.set(r.pid, r.cid);
      } else if (r.isPrimary) {
        deadPrimary.add(r.pid);
      }
    }
    const out = new Map(livePrimary);
    for (const pid of deadPrimary) {
      const fallback = firstLive.get(pid);
      if (!out.has(pid) && fallback) out.set(pid, fallback);
    }
    return out;
  },

  /**
   * Batched version of `listForProduct` — every category id linked to each
   * product, in ONE query, keyed by product_id. Used by the order workflow's
   * batched promotion resolver to feed `getActiveDiscountForProduct`'s
   * `categoryIds` per line without a per-line round-trip. Ids pass through
   * the same defensive `isUuid` guard as `listProductIdsInCategory`.
   * Products with no category links are simply absent from the map.
   *
   * LIVE categories only (like `listForProduct`): a promotion or scoped coupon
   * still pointing at a soft-deleted category must stop matching its old links.
   */
  async categoryIdsForProducts(productIds: string[]): Promise<Map<string, string[]>> {
    if (productIds.length === 0) return new Map();
    const rows = await db
      .select({
        pid: product_categories.product_id,
        cid: product_categories.category_id,
      })
      .from(product_categories)
      .innerJoin(categories, eq(categories.id, product_categories.category_id))
      .where(
        and(inArray(product_categories.product_id, productIds), isNull(categories.deleted_at)),
      );
    const map = new Map<string, string[]>();
    for (const r of rows) {
      if (!isUuid(r.cid)) continue;
      const arr = map.get(r.pid);
      if (arr) arr.push(r.cid);
      else map.set(r.pid, [r.cid]);
    }
    return map;
  },

  /**
   * Remove every category link row for the given product ids in one
   * statement. Used by demo clear to detach categories before products
   * themselves are hard-deleted.
   */
  async deleteForProducts(productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;
    await db
      .delete(product_categories)
      .where(inArray(product_categories.product_id, productIds));
  },

  /**
   * Remove every link row pointing at the given category ids in one
   * statement. `product_categories.category_id` has an `ON DELETE CASCADE` FK
   * (so a hard category delete would drop these rows anyway); the `clean`
   * data-job's `cleanCategories` segment still detaches explicitly here to keep
   * ordering/counts deterministic before the category rows are removed —
   * mirroring how `deleteForProducts` detaches before a product hard-delete.
   */
  async deleteForCategories(categoryIds: string[]): Promise<number> {
    if (categoryIds.length === 0) return 0;
    const rows = await db
      .delete(product_categories)
      .where(inArray(product_categories.category_id, categoryIds))
      .returning({ id: product_categories.id });
    return rows.length;
  },

  /**
   * Re-home every product link of `fromCategoryId` onto `toCategoryId`, keeping
   * each link's `is_primary` — the category soft-delete's "move the products to
   * the parent" step (mirrors how its live children are promoted). Two
   * statements, DELETE first: that frees the `product_categories_one_primary_
   * per_product` slot before a moved primary lands on the parent. A product
   * already linked to the parent keeps ONE row (pc_pair_unique), primary if
   * either link was. Returns the DISTINCT product ids whose links moved (for the
   * caller's product.updated fan-out). Run inside the caller's transaction.
   */
  async moveToCategory(
    fromCategoryId: string,
    toCategoryId: string,
    txOrDb: DbOrTx = db,
  ): Promise<string[]> {
    if (fromCategoryId === toCategoryId) return [];
    return txOrDb.transaction(async (tx) => {
      // Only onto a LIVE target (a legacy node could still hang off a tombstoned
      // parent) — re-homing onto a dead category would change nothing but churn.
      const [target] = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.id, toCategoryId), isNull(categories.deleted_at)))
        .limit(1);
      if (!target) return [];
      const moved = await tx
        .delete(product_categories)
        .where(eq(product_categories.category_id, fromCategoryId))
        .returning({ pid: product_categories.product_id, isPrimary: product_categories.is_primary });
      // Bounded VALUES lists (3 binds per row) — far under the 65 535-bind cap.
      const CHUNK = 1000;
      for (let i = 0; i < moved.length; i += CHUNK) {
        await tx
          .insert(product_categories)
          .values(
            moved.slice(i, i + CHUNK).map((m) => ({
              product_id: m.pid,
              category_id: toCategoryId,
              is_primary: m.isPrimary,
            })),
          )
          .onConflictDoUpdate({
            target: [product_categories.product_id, product_categories.category_id],
            set: {
              is_primary: sql`${product_categories.is_primary} OR excluded.is_primary`,
              updated_at: sql`now()`,
            },
          });
      }
      return [...new Set(moved.map((m) => m.pid))];
    });
  },
};

export const productBrandLink = {
  async set(productId: string, brandId: string | null, txOrDb: DbOrTx = db) {
    await txOrDb.transaction(async (tx) => {
      await tx.delete(product_brands).where(eq(product_brands.product_id, productId));
      if (brandId) {
        await tx.insert(product_brands).values({ product_id: productId, brand_id: brandId });
      }
    });
  },

  /**
   * The product's brand id — LIVE brands only. A soft-deleted brand keeps its
   * product_brands row (the FK only cascades on a hard delete) but must stop
   * driving brand-scoped promotions / coupons, exactly like the tax chain's
   * live-brand join (`@/modules/tax/queries`). Same rule on every brand reader
   * below so the PDP, cards and cart all agree.
   */
  async findBrandId(productId: string): Promise<string | null> {
    const [row] = await db
      .select({ bid: product_brands.brand_id })
      .from(product_brands)
      .innerJoin(brands, eq(brands.id, product_brands.brand_id))
      .where(and(eq(product_brands.product_id, productId), isNull(brands.deleted_at)))
      .limit(1);
    return row?.bid ?? null;
  },

  async findBrandIdsForProducts(productIds: string[]): Promise<Map<string, string>> {
    if (productIds.length === 0) return new Map();
    const rows = await db
      .select({ product_id: product_brands.product_id, brand_id: product_brands.brand_id })
      .from(product_brands)
      .innerJoin(brands, eq(brands.id, product_brands.brand_id))
      .where(and(inArray(product_brands.product_id, productIds), isNull(brands.deleted_at)));
    return new Map(rows.map((r) => [r.product_id, r.brand_id]));
  },

  /**
   * All product IDs linked to a given LIVE brand (empty for a soft-deleted one).
   * Used by the storefront brand-landing route to scope its product grid and by
   * the card promo map for brand-scoped promotions. Filters malformed IDs the
   * same way `productCategoryLinks.listProductIdsInCategory` does.
   */
  async listProductIdsForBrand(brandId: string): Promise<string[]> {
    const rows = await db
      .select({ pid: product_brands.product_id })
      .from(product_brands)
      .innerJoin(brands, eq(brands.id, product_brands.brand_id))
      .where(and(eq(product_brands.brand_id, brandId), isNull(brands.deleted_at)));
    return rows.map((r) => r.pid).filter(isUuid);
  },

  /**
   * PUBLISHED (live) product count per brand, in one batched query. Brands are
   * FLAT (no tree), so this is a plain COUNT(DISTINCT) GROUP BY — the brand twin of
   * countProductsForCategoryTrees. Used by the sitemap to drop empty brands (a
   * 0-product brand URL should not be advertised). A brand with no live products is
   * simply absent from the returned Map (callers read `.get(id) ?? 0`).
   */
  async countPublishedProductsForBrands(brandIds: string[]): Promise<Map<string, number>> {
    if (brandIds.length === 0) return new Map();
    const rows = await db
      .select({ brandId: product_brands.brand_id, n: sql<number>`count(distinct ${products.id})::int` })
      .from(product_brands)
      .innerJoin(products, eq(products.id, product_brands.product_id))
      .where(
        and(
          inArray(product_brands.brand_id, brandIds),
          eq(products.is_published, true),
          isNull(products.deleted_at),
        ),
      )
      .groupBy(product_brands.brand_id);
    return new Map(rows.map((r) => [r.brandId, Number(r.n)]));
  },

  /**
   * DB-paginated, PUBLISHED-only product ids for a brand, newest-first. The
   * `published` + ORDER + LIMIT/OFFSET live in SQL (unlike the unbounded
   * `listProductIdsForBrand`, which returns every link row) so a bounded caller
   * (markdown twins, feeds) never loads the whole brand catalogue. Mirrors
   * {@link listPublishedProductIdsInCategoryTreePaged}.
   */
  async listPublishedProductIdsForBrandPaged(
    brandId: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<string[]> {
    if (!isUuid(brandId)) return [];
    const limit = Math.min(Math.max(opts.limit ?? 24, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const result = await db.execute<{ id: string }>(sql`
      SELECT p.id
        FROM products p
        WHERE p.deleted_at IS NULL AND p.is_published = true
          AND p.id IN (
            SELECT pb.product_id FROM product_brands pb
              WHERE pb.brand_id = ${brandId}::uuid
          )
        ORDER BY p.published_at DESC NULLS LAST, p.id DESC
        LIMIT ${limit} OFFSET ${offset}
    `);
    return result.rows.map((r) => r.id).filter(isUuid);
  },

  /**
   * Remove every brand link row for the given product ids. Used by demo
   * clear to unwire products from brands before the products themselves
   * are hard-deleted.
   */
  async deleteForProducts(productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;
    await db
      .delete(product_brands)
      .where(inArray(product_brands.product_id, productIds));
  },
};

export const productMediaLink = {
  async list(productId: string): Promise<ProductMediaRow[]> {
    return db
      .select()
      .from(product_media)
      .where(eq(product_media.product_id, productId))
      .orderBy(desc(product_media.is_primary), asc(product_media.display_order));
  },

  /**
   * Batched version of `list` — returns a Map keyed by product_id with each
   * value being the same-ordered list `list()` would return. Used by
   * `mapProductRows` to avoid one query per product on listing pages.
   */
  async listForProducts(productIds: string[]): Promise<Map<string, ProductMediaRow[]>> {
    if (productIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(product_media)
      .where(inArray(product_media.product_id, productIds))
      .orderBy(desc(product_media.is_primary), asc(product_media.display_order));
    const map = new Map<string, ProductMediaRow[]>();
    for (const r of rows) {
      const arr = map.get(r.product_id);
      if (arr) {
        arr.push(r);
      } else {
        map.set(r.product_id, [r]);
      }
    }
    return map;
  },

  /**
   * Bulk-replace gallery in a single transaction.
   *
   *   - `mediaIds` order becomes `display_order`
   *   - if `primaryId` is set, that media becomes primary; otherwise the
   *     first entry takes that role (matches admin UX expectation that
   *     reordering also reassigns the cover)
   *   - empty `mediaIds` clears the gallery
   */
  async set(
    productId: string,
    mediaIds: string[],
    primaryId?: string,
    txOrDb: DbOrTx = db,
  ): Promise<void> {
    await txOrDb.transaction(async (tx) => {
      await tx.delete(product_media).where(eq(product_media.product_id, productId));
      if (mediaIds.length === 0) return;
      const effectivePrimary = primaryId ?? mediaIds[0];
      await tx.insert(product_media).values(
        mediaIds.map((mid, idx) => ({
          product_id: productId,
          media_id: mid,
          is_primary: mid === effectivePrimary,
          display_order: idx,
        })),
      );
    });
  },

  /**
   * Resolve the cover media id for each product — ONE row per product.
   *
   * Robust to bad data: imports can leave a product with SEVERAL `is_primary`
   * rows (a non-cleared sibling primary) or NONE. The previous version selected
   * `is_primary = true` with no ORDER BY and built a Map, so with duplicate
   * primaries Postgres' arbitrary row order made the chosen media id
   * NON-DETERMINISTIC — the same cart showed the right cover on one page and a
   * different image on the next (cart vs checkout vs order). Ordering by
   * (is_primary DESC, display_order ASC, id ASC) and taking the FIRST per
   * product makes the cover stable everywhere: a primary wins, else the first
   * gallery image (lowest display_order) — exactly the cover the admin gallery
   * editor assigns by default.
   */
  async primaryMediaIdsForProducts(productIds: string[]): Promise<Map<string, string>> {
    if (productIds.length === 0) return new Map();
    const rows = await db
      .select({
        product_id: product_media.product_id,
        media_id: product_media.media_id,
      })
      .from(product_media)
      .where(inArray(product_media.product_id, productIds))
      .orderBy(
        asc(product_media.product_id),
        desc(product_media.is_primary),
        asc(product_media.display_order),
        asc(product_media.id),
      );
    const out = new Map<string, string>();
    for (const r of rows) {
      if (!out.has(r.product_id)) out.set(r.product_id, r.media_id);
    }
    return out;
  },

  /**
   * Distinct media ids referenced by any of the given products. Used by the
   * demo-clear flow to know which media rows to consider sweeping after
   * the products themselves go away. Returns an empty array when there are
   * no products or no matches.
   */
  async listMediaIdsForProducts(productIds: string[]): Promise<string[]> {
    if (productIds.length === 0) return [];
    const rows = await db
      .selectDistinct({ id: product_media.media_id })
      .from(product_media)
      .where(inArray(product_media.product_id, productIds));
    return rows.map((r) => r.id);
  },

  /**
   * Remove every product_media join row for the given product ids in one
   * statement. Used by demo clear to detach images before the products
   * themselves are hard-deleted.
   */
  async deleteForProducts(productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;
    await db.delete(product_media).where(inArray(product_media.product_id, productIds));
  },
};

/**
 * product ↔ product CURATED related list ("Vous aimerez aussi" for the manual /
 * ai modes). REPLACE-semantics like the other links: `set()` clears then
 * re-inserts in array order (index → display_order). Self-references are
 * filtered out defensively (a product can't relate to itself).
 */
export const productRelatedLinks = {
  async set(productId: string, relatedIds: string[], txOrDb: DbOrTx = db): Promise<void> {
    // De-dupe, drop the product's own id, keep first-seen order.
    const seen = new Set<string>([productId]);
    const ordered: string[] = [];
    for (const rid of relatedIds) {
      if (!isUuid(rid) || seen.has(rid)) continue;
      seen.add(rid);
      ordered.push(rid);
    }
    await txOrDb.transaction(async (tx) => {
      await tx.delete(product_related).where(eq(product_related.product_id, productId));
      if (ordered.length === 0) return;
      await tx.insert(product_related).values(
        ordered.map((rid, idx) => ({
          product_id: productId,
          related_product_id: rid,
          display_order: idx,
        })),
      );
    });
  },

  /** Curated related product ids for a product, in display order. */
  async listForProduct(productId: string): Promise<string[]> {
    const rows = await db
      .select({ rid: product_related.related_product_id })
      .from(product_related)
      .where(eq(product_related.product_id, productId))
      .orderBy(asc(product_related.display_order), asc(product_related.id));
    return rows.map((r) => r.rid).filter(isUuid);
  },
};

/**
 * product ↔ product CURATED "Accessoires supplémentaires" list — the manual-only
 * complementary cross-sell shown as small accessory cards on the PDP. Same
 * REPLACE-semantics as the related links: `set()` clears then re-inserts in
 * array order (index → display_order). Self-references are filtered out
 * defensively (a product can't be its own accessory). There is no derived/AI
 * mode here — an empty list simply renders no section.
 */
export const productComplementaryLinks = {
  async set(productId: string, complementaryIds: string[], txOrDb: DbOrTx = db): Promise<void> {
    // De-dupe, drop the product's own id, keep first-seen order.
    const seen = new Set<string>([productId]);
    const ordered: string[] = [];
    for (const cid of complementaryIds) {
      if (!isUuid(cid) || seen.has(cid)) continue;
      seen.add(cid);
      ordered.push(cid);
    }
    await txOrDb.transaction(async (tx) => {
      await tx
        .delete(product_complementary)
        .where(eq(product_complementary.product_id, productId));
      if (ordered.length === 0) return;
      await tx.insert(product_complementary).values(
        ordered.map((cid, idx) => ({
          product_id: productId,
          complementary_product_id: cid,
          display_order: idx,
        })),
      );
    });
  },

  /** Curated complementary product ids for a product, in display order. */
  async listForProduct(productId: string): Promise<string[]> {
    const rows = await db
      .select({ cid: product_complementary.complementary_product_id })
      .from(product_complementary)
      .where(eq(product_complementary.product_id, productId))
      .orderBy(asc(product_complementary.display_order), asc(product_complementary.id));
    return rows.map((r) => r.cid).filter(isUuid);
  },
};
