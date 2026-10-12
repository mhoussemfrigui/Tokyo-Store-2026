import "server-only";

import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { stock_levels } from "@/modules/stock-location/schema";
import { LOW_STOCK_DEFAULTS } from "@/lib/inventory/low-stock";
import { stockStateSql } from "./queries";
import {
  product_variant_values,
  product_variants,
  products,
  type NewProductRow,
  type ProductRow,
} from "./schema";

/** Escape LIKE/ILIKE metacharacters so a user's `%`/`_`/`\` match literally
 *  (matches the brand/review/media services). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * One variant as submitted by the admin editor. `id` present ⇒ update an
 * existing row (keeps its id so cart/order references survive an edit);
 * absent ⇒ insert. `attributeValueIds` is the combination that defines it.
 *
 * `stockQty` / `inStock` `undefined` on an EXISTING row ⇒ that column is left
 * untouched (the editor didn't change it — re-writing the page-load value would
 * resurrect units sold since); on an insert ⇒ the column default (NULL =
 * untracked / in stock).
 */
export type VariantInput = {
  id?: string | null;
  label: string;
  sku: string | null;
  gtin: string | null;
  mpn: string | null;
  priceCents: number;
  oldPriceCents: number | null;
  stockQty?: number | null;
  inStock?: boolean;
  imageMediaId: string | null;
  displayOrder: number;
  isDefault: boolean;
  attributeValueIds: string[];
};

/**
 * Catalogue-wide product statistics — the single source of truth for both
 * `getProductStats`'s return shape and the admin `ProductStatsPanel` prop (which
 * imports this type-only, so the `server-only` guard above is never bundled into
 * the client). Previously the 14-field shape was hand-synced in two places.
 */
export type ProductStats = {
  total: number;
  inStock: number;
  outOfStock: number;
  published: number;
  draft: number;
  withoutCategory: number;
  withoutBrand: number;
  withoutDescription: number;
  withoutShort: number;
  withoutMeta: number;
  withoutSpecs: number;
  withoutImage: number;
  withVariants: number;
  onSale: number;
};

class ProductService {
  async findById(id: string): Promise<ProductRow | null> {
    const [row] = await db
      .select()
      .from(products)
      .where(and(eq(products.id, id), isNull(products.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async findBySlug(slug: string): Promise<ProductRow | null> {
    const [row] = await db
      .select()
      .from(products)
      .where(and(eq(products.slug, slug), isNull(products.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Reference lookups for the external API (ERP linkage). Each resolves a single
   * LIVE product by one identifier — O(1) via the partial unique indexes on
   * sku / gtin / external_ref. NOT a fallback chain: the caller picks the field.
   */
  async findBySku(sku: string): Promise<ProductRow | null> {
    const [row] = await db
      .select()
      .from(products)
      .where(and(eq(products.sku, sku), isNull(products.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async findByGtin(gtin: string): Promise<ProductRow | null> {
    const [row] = await db
      .select()
      .from(products)
      .where(and(eq(products.gtin, gtin), isNull(products.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async findByExternalRef(externalRef: string): Promise<ProductRow | null> {
    const [row] = await db
      .select()
      .from(products)
      .where(and(eq(products.external_ref, externalRef), isNull(products.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Lean identifier projection by id — the SKU / GTIN / external_ref an ERP
   * correlates on. Used to enrich outbound review webhooks so a consumer can match
   * the event to its own product without a second call. Ignores `deleted_at` (a
   * `review.deleted` event may reference a since-removed product, and the
   * identifiers still help reconcile); returns null only when no row exists.
   */
  async findIdentifiers(
    id: string,
  ): Promise<{ sku: string | null; gtin: string | null; externalRef: string | null } | null> {
    const [row] = await db
      .select({ sku: products.sku, gtin: products.gtin, externalRef: products.external_ref })
      .from(products)
      .where(eq(products.id, id))
      .limit(1);
    return row ?? null;
  }

  async insert(input: NewProductRow, txOrDb: DbOrTx = db): Promise<ProductRow> {
    const [row] = await txOrDb.insert(products).values(input).returning();
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<ProductRow, "id" | "created_at">>,
    txOrDb: DbOrTx = db,
  ): Promise<ProductRow | null> {
    const [row] = await txOrDb
      .update(products)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(products.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * `{id, stock_qty, in_stock}` for a product's LIVE (non-deleted) variants —
   * used to compute per-variant ledger deltas when the variant editor changes
   * stock. `forUpdate` (inside a tx) row-locks them so the editor's
   * compare-and-set + ledger serialize against a concurrent order decrement.
   */
  async listVariantStock(
    productId: string,
    txOrDb: DbOrTx = db,
    opts: { forUpdate?: boolean } = {},
  ): Promise<{ id: string; stock_qty: number | null; in_stock: boolean; price_cents: number }[]> {
    const q = txOrDb
      .select({
        id: product_variants.id,
        stock_qty: product_variants.stock_qty,
        in_stock: product_variants.in_stock,
        price_cents: product_variants.price_cents,
      })
      .from(product_variants)
      .where(and(eq(product_variants.product_id, productId), isNull(product_variants.deleted_at)));
    return opts.forUpdate ? q.for("update") : q;
  }

  /**
   * Row-lock a product (FOR UPDATE, inside the caller's tx) and read its CURRENT
   * stock — the committed value a stock write must compare against / ledger from,
   * not a pre-tx read that a concurrent order decrement may have outdated.
   */
  async lockStock(
    id: string,
    tx: DbOrTx,
  ): Promise<{ stock_qty: number | null; in_stock: boolean } | null> {
    const [row] = await tx
      .select({ stock_qty: products.stock_qty, in_stock: products.in_stock })
      .from(products)
      .where(eq(products.id, id))
      .for("update")
      .limit(1);
    return row ?? null;
  }

  /**
   * Soft-delete a product. Also drops its PRODUCT-POOL per-location levels (a
   * deleted product is no longer sellable — leftover levels would keep counting
   * in the Emplacements unit totals / location-delete guard). Its variants are
   * released by the delete workflow (replaceVariants(id, [])) in the same tx.
   */
  async softDelete(id: string, txOrDb: DbOrTx = db): Promise<void> {
    await txOrDb
      .update(products)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(products.id, id));
    await txOrDb
      .delete(stock_levels)
      .where(and(eq(stock_levels.product_id, id), isNull(stock_levels.variant_id)));
  }

  /**
   * Server-side stock listing for the admin inventory page: the stock FILTER is
   * pushed into SQL (so "out of stock" surfaces across the WHOLE catalog, not
   * just a fetched window) and paginated with a TRUE total count. `search`
   * matches name OR sku. The filter predicates are the SHARED `stockStateSql`
   * (also behind the dashboard « Stock faible » count); `lowThreshold` is the
   * operator's configured `stock.low_threshold_qty` (resolveLowStockConfig) —
   * the same line the low-stock alert emails use — defaulting to 5.
   */
  async listStockPaged(opts: {
    search?: string;
    filter?: string;
    lowThreshold?: number;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: ProductRow[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 10), 200);
    const conds = [isNull(products.deleted_at)];
    if (opts.search) {
      const like = `%${escapeLike(opts.search)}%`;
      conds.push(or(ilike(products.name, like), ilike(products.sku, like))!);
    }
    switch (opts.filter) {
      case "in_stock":
      case "low":
      case "out_of_stock":
      case "none":
        conds.push(stockStateSql(opts.filter, opts.lowThreshold ?? LOW_STOCK_DEFAULTS.threshold));
        break;
      default:
        break;
    }
    const where = and(...conds);
    const [items, [cnt]] = await Promise.all([
      // Stable tiebreak on id so OFFSET pagination is deterministic when rows
      // share a created_at (bulk imports) — no duplicated/skipped rows.
      db
        .select()
        .from(products)
        .where(where)
        .orderBy(desc(products.created_at), desc(products.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ v: count() }).from(products).where(where),
    ]);
    return { items, total: Number(cnt?.v ?? 0), page, pageSize };
  }

  /**
   * Paged admin listing with filtering by query, category, and publish-state.
   *
   * `q` matches against name + sku (case-insensitive). `categoryId` scopes to
   * IDs found via the product_categories link table — passed in by the caller
   * to keep this service free of the association table. `status` flips the
   * `is_published` filter (no draft/archived enum yet, so "archived" maps to
   * the soft-delete column).
   */
  async listAdminPaged(opts: {
    q?: string;
    productIds?: string[] | null;
    status?: "draft" | "published" | "archived";
    page?: number;
    pageSize?: number;
  }): Promise<{ items: ProductRow[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 25, 5), 100);

    const conditions = [];
    if (opts.status === "archived") {
      // archived view: soft-deleted only
      conditions.push(sql`${products.deleted_at} is not null`);
    } else {
      conditions.push(isNull(products.deleted_at));
      if (opts.status === "published") conditions.push(eq(products.is_published, true));
      if (opts.status === "draft") conditions.push(eq(products.is_published, false));
    }
    if (opts.q) {
      const like = `%${escapeLike(opts.q)}%`;
      conditions.push(or(ilike(products.name, like), ilike(products.sku, like))!);
    }
    if (opts.productIds !== undefined && opts.productIds !== null) {
      if (opts.productIds.length === 0) {
        return { items: [], total: 0, page, pageSize };
      }
      conditions.push(inArray(products.id, opts.productIds));
    }

    const whereExpr = and(...conditions);

    const [{ value: total }] = await db
      .select({ value: count() })
      .from(products)
      .where(whereExpr);

    const items = await db
      .select()
      .from(products)
      .where(whereExpr)
      // Stable tiebreak on id keeps OFFSET pagination deterministic when
      // several rows share the same created_at (no duplicate/skipped rows).
      .orderBy(desc(products.created_at), desc(products.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return { items, total: Number(total ?? 0), page, pageSize };
  }

  /**
   * Reconcile a product's variants against the admin-submitted list.
   *
   * Id-stable on purpose: rows carrying an `id` are UPDATED in place so any
   * cart_items / order_items pointing at a variant survive an edit; rows
   * without an id are inserted; existing rows missing from the list are
   * SOFT-deleted (order history snapshots the variant, so this never orphans
   * a past purchase). Each variant's attribute-value links are replaced
   * wholesale. Runs in a (possibly nested) transaction so a product save that
   * also touches variants stays atomic.
   *
   * Returns the REMOVED variants with the stock_qty they held just before being
   * zeroed, so the caller can ledger the units leaving (`stock_movements`) in the
   * same transaction — this service only writes the rows, never the ledger.
   */
  async replaceVariants(
    productId: string,
    variants: VariantInput[],
    txOrDb: DbOrTx = db,
  ): Promise<{ removed: Array<{ id: string; stockQty: number | null }> }> {
    return txOrDb.transaction(async (tx) => {
      const existing = await tx
        .select({ id: product_variants.id })
        .from(product_variants)
        .where(
          and(eq(product_variants.product_id, productId), isNull(product_variants.deleted_at)),
        );
      const existingIds = new Set(existing.map((r) => r.id));
      const keptIds = new Set<string>();

      // Pre-clear the single-default flag on every live variant of this product
      // so the loop's per-row UPDATEs can't transiently leave two rows with
      // is_default=true — which the NON-deferrable partial unique index
      // `product_variants_one_default_per_product` rejects immediately, aborting
      // the whole save — when the default moves to an EARLIER variant in the
      // array. The loop below re-sets is_default on the chosen row.
      await tx
        .update(product_variants)
        .set({ is_default: false })
        .where(
          and(eq(product_variants.product_id, productId), isNull(product_variants.deleted_at)),
        );

      // Pre-FREE sku/gtin on every live variant so the per-row writes below can
      // relabel/reorder/SWAP codes (A↔B) — or reuse a code held by a variant
      // that's leaving the set — without transiently colliding with the still-
      // live old row on the partial unique indexes (product_variants_sku_unique /
      // _gtin_unique, over deleted_at IS NULL). The loop re-assigns the final
      // codes; rows that leave the set keep their freed (null) code and are
      // soft-deleted at the end. Without this, a legitimate swap/reuse raised a
      // raw 23505 that the workflow surfaced as a spurious "SKU déjà utilisé".
      await tx
        .update(product_variants)
        .set({ sku: null, gtin: null })
        .where(
          and(eq(product_variants.product_id, productId), isNull(product_variants.deleted_at)),
        );

      // Prefetch existing attribute-value links for the kept variants so each
      // combo can be DIFFED (add/remove only) rather than blindly
      // deleted+reinserted — the common price/stock-only edit leaves the combo
      // unchanged, so we avoid churning the link table + its 3 indexes / WAL.
      const existingLinks = new Map<string, Set<string>>();
      if (existingIds.size > 0) {
        const links = await tx
          .select({
            variant_id: product_variant_values.variant_id,
            attribute_value_id: product_variant_values.attribute_value_id,
          })
          .from(product_variant_values)
          .where(inArray(product_variant_values.variant_id, [...existingIds]));
        for (const l of links) {
          const set = existingLinks.get(l.variant_id) ?? new Set<string>();
          set.add(l.attribute_value_id);
          existingLinks.set(l.variant_id, set);
        }
      }

      for (const [idx, v] of variants.entries()) {
        const values = {
          product_id: productId,
          label: v.label,
          sku: v.sku,
          gtin: v.gtin,
          mpn: v.mpn,
          price_cents: v.priceCents,
          old_price_cents: v.oldPriceCents,
          // Stock columns only when given — `undefined` leaves an existing row's
          // stock untouched (see VariantInput) and lets an insert take the default.
          ...(v.stockQty !== undefined ? { stock_qty: v.stockQty } : {}),
          ...(v.inStock !== undefined ? { in_stock: v.inStock } : {}),
          image_media_id: v.imageMediaId,
          display_order: v.displayOrder ?? idx,
          is_default: v.isDefault,
        };

        let variantId: string;
        if (v.id && existingIds.has(v.id)) {
          await tx
            .update(product_variants)
            .set({ ...values, updated_at: new Date() })
            .where(eq(product_variants.id, v.id));
          variantId = v.id;
        } else {
          const [inserted] = await tx
            .insert(product_variants)
            .values(values)
            .returning({ id: product_variants.id });
          variantId = inserted.id;
        }
        keptIds.add(variantId);

        // Diff the attribute-value combination — insert only the newly-added
        // value ids, delete only the removed ones. A new variant (no prior
        // links) inserts all; an unchanged combo touches nothing.
        const uniqueVals = Array.from(new Set(v.attributeValueIds.filter(Boolean)));
        const prev = existingLinks.get(variantId) ?? new Set<string>();
        const next = new Set(uniqueVals);
        const toAdd = uniqueVals.filter((avid) => !prev.has(avid));
        const toRemove = [...prev].filter((avid) => !next.has(avid));
        if (toRemove.length > 0) {
          await tx
            .delete(product_variant_values)
            .where(
              and(
                eq(product_variant_values.variant_id, variantId),
                inArray(product_variant_values.attribute_value_id, toRemove),
              ),
            );
        }
        if (toAdd.length > 0) {
          await tx.insert(product_variant_values).values(
            toAdd.map((avid) => ({ variant_id: variantId, attribute_value_id: avid })),
          );
        }
      }

      const toDelete = [...existingIds].filter((id) => !keptIds.has(id));
      let removed: Array<{ id: string; stockQty: number | null }> = [];
      if (toDelete.length > 0) {
        // The pre-clear UPDATEs above already row-locked every live variant of
        // this product, so this read is the exact quantity about to be zeroed (no
        // concurrent sale can move it before the soft-delete below).
        removed = await tx
          .select({ id: product_variants.id, stockQty: product_variants.stock_qty })
          .from(product_variants)
          .where(inArray(product_variants.id, toDelete));
        // Soft-delete the variant AND clear its stock: zero its cached total and
        // drop its per-location levels. A deleted variant is no longer sellable,
        // so leaving stock_levels behind would orphan rows outside the cached
        // SUM and could restore phantom stock if the variant is ever un-deleted.
        await tx
          .update(product_variants)
          .set({ deleted_at: new Date(), stock_qty: 0, in_stock: false })
          .where(inArray(product_variants.id, toDelete));
        await tx.delete(stock_levels).where(inArray(stock_levels.variant_id, toDelete));
      }
      return { removed };
    });
  }

  // ──────────────────────────────────────── bulk lookups
  /**
   * Batch-load LIVE products by id (order not guaranteed — callers index by id).
   * Used by the AI auto-assignment runner to hydrate the rows it classifies
   * after enumerating ids with `listAllIds()`.
   */
  async listByIds(ids: string[]): Promise<ProductRow[]> {
    if (ids.length === 0) return [];
    // Chunk the IN-list so a large bulk-AI scope (thousands of ids) can't blow
    // the Postgres bind-parameter limit. Single-batch fast path for the common
    // small case; concat across batches otherwise (order not guaranteed —
    // callers index by id).
    const CHUNK = 500;
    if (ids.length <= CHUNK) {
      return db
        .select()
        .from(products)
        .where(and(inArray(products.id, ids), isNull(products.deleted_at)));
    }
    const out: ProductRow[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK);
      const rows = await db
        .select()
        .from(products)
        .where(and(inArray(products.id, batch), isNull(products.deleted_at)));
      out.push(...rows);
    }
    return out;
  }

  /**
   * Hard-delete a set of products by their ids. Returns the ids of deleted
   * products so callers can report counts. Associations (product_brands,
   * product_categories, product_media) and references to other modules must be
   * cleaned by the caller — this method only owns rows living in the product
   * module.
   */
  async deleteByIds(ids: string[], txOrDb: DbOrTx = db): Promise<string[]> {
    if (ids.length === 0) return [];
    return txOrDb.transaction(async (tx) => {
      const rows = await tx
        .delete(products)
        .where(inArray(products.id, ids))
        .returning({ id: products.id });
      return rows.map((r) => r.id);
    });
  }

  /** Every live product id. Used by the demo "clear" path — the demo now
   *  seeds the entire catalog (the bundled feed), so clearing it wipes all
   *  products, not a hand-picked fixture set. */
  async listAllIds(): Promise<string[]> {
    const rows = await db
      .select({ id: products.id })
      .from(products)
      .where(isNull(products.deleted_at));
    return rows.map((r) => r.id);
  }

  /**
   * Catalogue-wide product statistics for the Produits header (pill + expandable
   * breakdown). One pass over live products with FILTER aggregates; the
   * "without-X" completeness checks use uncorrelated `NOT IN (SELECT …)` set
   * membership (association tables), which Postgres hashes once. Soft-deleted rows
   * are excluded. All counts are returned as numbers.
   */
  async getProductStats(): Promise<ProductStats> {
    const res = await db.execute<Record<string, number | string | null>>(sql`
      SELECT
        count(*)::int AS total,
        -- Quantity-aware availability, matching the list pill (isEffectivelyOutOfStock)
        -- + the Stock page filter: a SIMPLE product in_stock but stock_qty = 0 is OUT.
        -- Variable products track stock per-variant (stock_qty is null at this level),
        -- so they fall back to the in_stock flag.
        count(*) FILTER (WHERE p.in_stock AND (p.product_type = 'variable' OR p.stock_qty IS NULL OR p.stock_qty > 0))::int AS in_stock,
        count(*) FILTER (WHERE NOT (p.in_stock AND (p.product_type = 'variable' OR p.stock_qty IS NULL OR p.stock_qty > 0)))::int AS out_of_stock,
        count(*) FILTER (WHERE p.is_published)::int AS published,
        count(*) FILTER (WHERE NOT p.is_published)::int AS draft,
        count(*) FILTER (WHERE p.id NOT IN (SELECT product_id FROM product_categories))::int AS without_category,
        count(*) FILTER (WHERE p.id NOT IN (SELECT product_id FROM product_brands))::int AS without_brand,
        count(*) FILTER (WHERE p.description = '')::int AS without_description,
        count(*) FILTER (WHERE p.short_desc = '')::int AS without_short,
        count(*) FILTER (WHERE COALESCE(p.meta_title, '') = '' AND COALESCE(p.meta_description, '') = '')::int AS without_meta,
        count(*) FILTER (
          WHERE p.id NOT IN (SELECT product_id FROM product_attribute_assignments)
            AND p.id NOT IN (SELECT product_id FROM product_attribute_scalars)
        )::int AS without_specs,
        count(*) FILTER (WHERE p.id NOT IN (SELECT product_id FROM product_media))::int AS without_image,
        count(*) FILTER (WHERE p.product_type = 'variable')::int AS with_variants,
        -- "En promotion" must match the compare-at the STOREFRONT shows: a VARIABLE
        -- product's card/PDP markdown derives from its CHEAPEST live variant (price
        -- ASC, then display order), NOT the parent row — mirrors the raw-cents
        -- comparison in listPublishedCompareAtProducts (catalog/product/queries.ts).
        -- A simple product keeps its own old_price vs price. Counts all live rows
        -- (published + draft), so it is wider than the published-only promo pool but
        -- uses the identical variant-aware LOGIC.
        count(*) FILTER (
          WHERE (
            CASE
              WHEN p.product_type = 'variable' AND EXISTS (
                SELECT 1 FROM product_variants pv
                WHERE pv.product_id = p.id AND pv.deleted_at IS NULL
              )
              THEN (
                SELECT pv.old_price_cents FROM product_variants pv
                WHERE pv.product_id = p.id AND pv.deleted_at IS NULL
                ORDER BY pv.price_cents ASC, pv.display_order ASC, pv.created_at ASC, pv.id ASC
                LIMIT 1
              )
              ELSE p.old_price_cents
            END
          ) > (
            CASE
              WHEN p.product_type = 'variable' AND EXISTS (
                SELECT 1 FROM product_variants pv
                WHERE pv.product_id = p.id AND pv.deleted_at IS NULL
              )
              THEN (
                SELECT pv.price_cents FROM product_variants pv
                WHERE pv.product_id = p.id AND pv.deleted_at IS NULL
                ORDER BY pv.price_cents ASC, pv.display_order ASC, pv.created_at ASC, pv.id ASC
                LIMIT 1
              )
              ELSE p.price_cents
            END
          )
        )::int AS on_sale
      FROM products p
      WHERE p.deleted_at IS NULL
    `);
    const r = res.rows[0] ?? {};
    const num = (k: string) => Number(r[k] ?? 0);
    return {
      total: num("total"),
      inStock: num("in_stock"),
      outOfStock: num("out_of_stock"),
      published: num("published"),
      draft: num("draft"),
      withoutCategory: num("without_category"),
      withoutBrand: num("without_brand"),
      withoutDescription: num("without_description"),
      withoutShort: num("without_short"),
      withoutMeta: num("without_meta"),
      withoutSpecs: num("without_specs"),
      withoutImage: num("without_image"),
      withVariants: num("with_variants"),
      onSale: num("on_sale"),
    };
  }
}

export const productService = new ProductService();
