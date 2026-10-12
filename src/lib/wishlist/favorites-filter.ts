import "server-only";

import { and, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { wishlist_items, wishlists } from "@/modules/wishlist/schema";
import { products } from "@/modules/catalog/product/schema";
import { categories } from "@/modules/catalog/category/schema";
import { product_categories } from "@/associations/product-category";
import { UUID_RE } from "@/lib/api/cursor";
import type { FavoritesFilter, FavoritedProductRow, FavoritesStats } from "./favorites-filter-shared";

/**
 * SERVER-side application of the Favoris demand filter (./favorites-filter-shared.ts).
 * Powers the search action (keyset-paginated ranked list), the filterable stats header,
 * and the filtered CSV export — all off ONE query shape, so list / count / export agree.
 *
 * SHAPE: `d` groups every favorite (wishlist_items) by product, joined to the LIVE
 * (non-deleted) product for name/slug/stock/price/published — the same visibility rule
 * as globalStats (a product soft-delete keeps its wishlist_items but drops off the board).
 * Product-level filters (search / stock / published) prune
 * inside `d`; the primary category is resolved per product via LEFT JOIN LATERAL (one row,
 * so a product's multiple categories can't multiply its favorite count) and the category
 * filter applies on it. Ranking is (count DESC, product_id DESC) with a keyset cursor
 * `<count>|<product_id>`. Backed by wishlist_items_product_idx.
 */

const PRODUCT_LIMIT = 200;

/** Pre-group WHERE on wishlist_items wi / products p (product-level filters). */
function productWhere(f: FavoritesFilter): SQL[] {
  const c: SQL[] = [sql`p.deleted_at is null`];
  const q = f.search.trim();
  if (q) c.push(sql`p.name ilike ${`%${q}%`}`);
  if (f.stock === "in") c.push(sql`p.in_stock = true`);
  else if (f.stock === "out") c.push(sql`p.in_stock = false`);
  if (f.published === "yes") c.push(sql`p.is_published = true`);
  else if (f.published === "no") c.push(sql`p.is_published = false`);
  return c;
}

/** The grouped-demand CTE `d`. */
function demandCte(f: FavoritesFilter): SQL {
  return sql`
    d as (
      select
        wi.product_id as product_id,
        p.name, p.slug, p.in_stock, p.stock_qty, p.price_cents, p.is_published,
        count(*)::int as cnt,
        count(*) filter (where wi.created_at >= now() - interval '7 days')::int as recent7,
        count(*) filter (where wi.created_at >= now() - interval '30 days')::int as recent30,
        max(wi.created_at) as last_added
      from ${wishlist_items} wi
      join ${products} p on p.id = wi.product_id
      where ${and(...productWhere(f))}
      group by wi.product_id, p.name, p.slug, p.in_stock, p.stock_qty, p.price_cents, p.is_published
    )`;
}

/** Primary-category LATERAL (≤1 row) + the category filter, if any. */
/** The category FILTER as an EXISTS on the grouped product — prunes BEFORE the sort/limit
 *  (index pc_pair_unique), so a category-filtered page never over-scans, and the display
 *  category is resolved separately (below) only on the surviving rows. */
function categoryExists(f: FavoritesFilter): SQL | null {
  if (!(f.categoryId && UUID_RE.test(f.categoryId))) return null;
  return sql`exists (select 1 from ${product_categories} pc join ${categories} c on c.id = pc.category_id and c.deleted_at is null where pc.product_id = d.product_id and pc.is_primary = true and c.id = ${f.categoryId}::uuid)`;
}

/** Display primary-category LATERAL (≤1 row). Joined onto the ALREADY-LIMITED `picked` rows
 *  so it resolves the category for the ≤limit output rows only, not the whole grouped set. */
const displayCatJoin = sql`
  left join lateral (
    select c.id, c.name, c.slug
    from ${product_categories} pc
    join ${categories} c on c.id = pc.category_id and c.deleted_at is null
    where pc.product_id = picked.product_id and pc.is_primary = true
    limit 1
  ) cat on true`;

type DemandRow = {
  product_id: string;
  name: string | null;
  slug: string | null;
  in_stock: boolean | null;
  stock_qty: number | null;
  price_cents: number;
  is_published: boolean | null;
  cnt: number;
  recent30: number;
  last_added: string | Date | null;
  category_id: string | null;
  category_name: string | null;
  category_slug: string | null;
};

const toIso = (v: string | Date | null): string | null =>
  v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString();

/** One keyset page of ranked favorited products (used by the list action AND the export). */
export async function listFavoritedProducts(
  filter: FavoritesFilter,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ items: FavoritedProductRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), PRODUCT_LIMIT);
  // Filters that PRUNE before the sort/limit: keyset cursor + the category EXISTS.
  const pickWhere: SQL[] = [sql`true`];
  const catFilter = categoryExists(filter);
  if (catFilter) pickWhere.push(catFilter);

  if (opts.cursor) {
    // Cursor = `<count>|<product_id>`; count is an int (no '|'), product_id a uuid (no '|').
    const sep = opts.cursor.indexOf("|");
    if (sep > 0) {
      const curCnt = Number(opts.cursor.slice(0, sep));
      const curId = opts.cursor.slice(sep + 1);
      if (Number.isInteger(curCnt) && UUID_RE.test(curId)) {
        pickWhere.push(sql`(d.cnt < ${curCnt} or (d.cnt = ${curCnt} and d.product_id < ${curId}::uuid))`);
      }
    }
  }

  // `picked` sorts + limits FIRST (the category is only for display), then the display
  // category LATERAL runs on the ≤limit survivors — not the whole grouped set.
  const res = await db.execute<DemandRow>(sql`
    with ${demandCte(filter)},
    picked as (
      select d.* from d
      where ${and(...pickWhere)}
      order by d.cnt desc, d.product_id desc
      limit ${limit + 1}
    )
    select
      picked.product_id, picked.name, picked.slug, picked.in_stock, picked.stock_qty, picked.price_cents, picked.is_published,
      picked.cnt, picked.recent30, picked.last_added,
      cat.id as category_id, cat.name as category_name, cat.slug as category_slug
    from picked
    ${displayCatJoin}
    order by picked.cnt desc, picked.product_id desc
  `);

  const rows = res.rows;
  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const last = trimmed[trimmed.length - 1];
  return {
    items: trimmed.map((r) => ({
      productId: r.product_id,
      name: r.name,
      slug: r.slug,
      count: Number(r.cnt),
      recent30: Number(r.recent30),
      inStock: Boolean(r.in_stock),
      stockQty: r.stock_qty == null ? null : Number(r.stock_qty),
      priceCents: Number(r.price_cents),
      isPublished: Boolean(r.is_published),
      categoryId: r.category_id,
      categoryName: r.category_name,
      categorySlug: r.category_slug,
      lastAddedAt: toIso(r.last_added),
    })),
    nextCursor: hasMore && last ? `${last.cnt}|${last.product_id}` : null,
  };
}

type StatsRow = {
  total_products: number;
  total_saves: string;
  in_stock: number;
  out_of_stock: number;
  recent7: string;
  recent30: string;
};

/** One aggregate pass over the FILTERED favorited-product set. Uses the SAME category
 *  EXISTS filter as the list (no display join needed), so the counts always match. */
export async function favoritesDemandStats(filter: FavoritesFilter): Promise<FavoritesStats> {
  const catFilter = categoryExists(filter);
  const res = await db.execute<StatsRow>(sql`
    with ${demandCte(filter)},
    j as (
      select d.cnt, d.recent7, d.recent30, d.in_stock
      from d
      where ${and(...(catFilter ? [sql`true`, catFilter] : [sql`true`]))}
    )
    select
      count(*)::int as total_products,
      coalesce(sum(cnt), 0)::bigint as total_saves,
      count(*) filter (where in_stock)::int as in_stock,
      count(*) filter (where not in_stock)::int as out_of_stock,
      coalesce(sum(recent7), 0)::bigint as recent7,
      coalesce(sum(recent30), 0)::bigint as recent30
    from j
  `);
  const r = res.rows[0];
  return {
    totalProducts: Number(r?.total_products ?? 0),
    totalSaves: Number(r?.total_saves ?? 0),
    inStock: Number(r?.in_stock ?? 0),
    outOfStock: Number(r?.out_of_stock ?? 0),
    recentSaves7: Number(r?.recent7 ?? 0),
    recentSaves30: Number(r?.recent30 ?? 0),
  };
}

/** Categories that have ≥1 favorited product — for the filter dropdown (most-favorited first). */
export async function favoritedCategories(): Promise<Array<{ id: string; name: string }>> {
  const res = await db.execute<{ id: string; name: string }>(sql`
    select c.id, c.name
    from ${wishlist_items} wi
    join ${products} p on p.id = wi.product_id and p.deleted_at is null
    join ${product_categories} pc on pc.product_id = wi.product_id and pc.is_primary = true
    join ${categories} c on c.id = pc.category_id and c.deleted_at is null
    group by c.id, c.name
    order by count(*) desc
    limit 100
  `);
  return res.rows.map((r) => ({ id: r.id, name: r.name }));
}

/** Active-list composition — lists with ≥1 favorite ON A LIVE PRODUCT (same visibility as
 *  globalStats, so « Listes actives » + the avgPerList denominator reconcile with the rest
 *  of the KPI strip): members (signed-in) vs guests (token). */
export async function favoritesComposition(): Promise<{ memberLists: number; guestLists: number }> {
  const res = await db.execute<{ members: number; guests: number }>(sql`
    select
      count(*) filter (where w.user_id is not null)::int as members,
      count(*) filter (where w.user_id is null)::int as guests
    from ${wishlists} w
    where exists (
      select 1 from ${wishlist_items} wi
      join ${products} p on p.id = wi.product_id and p.deleted_at is null
      where wi.wishlist_id = w.id
    )
  `);
  const r = res.rows[0];
  return { memberLists: Number(r?.members ?? 0), guestLists: Number(r?.guests ?? 0) };
}
