import "server-only";

/**
 * Favoris DEMAND filter + stats + keyset pagination (Clients → Favoris tab). Seeds tagged
 * products (distinct stock / published / favorite-count) under one tagged category, favorited
 * across member + guest wishlists, then asserts listFavoritedProducts / favoritesDemandStats
 * agree over the isolated set (isolated via a product-name search tag; stats are global).
 * Covers stock/published/category filters + the out-of-stock (restock) signal + recency +
 * a keyset walk that splits a count tie across a page boundary. Self-cleaning (favtest). Run:
 *   export DATABASE_URL=$(grep ^DATABASE_URL= .env.development.local|cut -d= -f2-)
 *   tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/favorites-filter.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { categories } from "@/modules/catalog/category/schema";
import { product_categories } from "@/associations/product-category";
import { wishlists, wishlist_items } from "@/modules/wishlist/schema";
import { authService } from "@/modules/auth/service";
import {
  listFavoritedProducts,
  favoritesDemandStats,
  favoritedCategories,
  favoritesComposition,
} from "@/lib/wishlist/favorites-filter";
import { EMPTY_FAVORITES_FILTER, type FavoritesFilter } from "@/lib/wishlist/favorites-filter-shared";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "favtest";
const f = (over: Partial<FavoritesFilter>): FavoritesFilter => ({ ...EMPTY_FAVORITES_FILTER, search: TAG, ...over });

async function cleanup() {
  await db.execute(sql`delete from wishlists where token like ${TAG + "%"} or user_id like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
  await db.execute(sql`delete from product_categories where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from categories where slug like ${TAG + "%"}`);
}

async function mkProduct(
  key: string,
  o: { inStock: boolean; published: boolean; stockQty: number; catId: string | null; extraCatId?: string },
): Promise<string> {
  const [p] = await db.insert(products).values({
    slug: `${TAG}-${key}`,
    name: `${TAG} product ${key}`,
    price_cents: 100_000,
    in_stock: o.inStock,
    is_published: o.published,
    stock_qty: o.stockQty,
  } as never).returning({ id: products.id });
  if (o.catId) await db.insert(product_categories).values({ product_id: p.id, category_id: o.catId, is_primary: true } as never);
  if (o.extraCatId) await db.insert(product_categories).values({ product_id: p.id, category_id: o.extraCatId, is_primary: false } as never);
  return p.id;
}

async function main() {
  await cleanup();

  const [cat] = await db.insert(categories).values({ name: `${TAG} Cat`, slug: TAG } as never).returning({ id: categories.id });
  const [cat2] = await db.insert(categories).values({ name: `${TAG} Cat2`, slug: `${TAG}2` } as never).returning({ id: categories.id });

  const p1 = await mkProduct("p1", { inStock: true, published: true, stockQty: 5, catId: cat.id }); // 3 favs (1 mid-window)
  const p2 = await mkProduct("p2", { inStock: false, published: true, stockQty: 0, catId: cat.id }); // 2 favs — OUT
  const p3 = await mkProduct("p3", { inStock: true, published: false, stockQty: 3, catId: cat.id }); // 1 fav — UNpublished, OLD
  const p4 = await mkProduct("p4", { inStock: true, published: true, stockQty: 8, catId: cat.id }); // 1 fav
  const p5 = await mkProduct("p5", { inStock: true, published: true, stockQty: 2, catId: null }); // 1 fav — NO primary category
  const p6 = await mkProduct("p6", { inStock: true, published: true, stockQty: 4, catId: cat.id, extraCatId: cat2.id }); // 1 fav — TWO categories

  // Two member wishlists + one guest wishlist.
  const u1 = `${TAG}-u1`, u2 = `${TAG}-u2`;
  await authService.insert({ id: u1, email: `${u1}@x.test`, name: u1, role: "customer", emailVerified: true } as never);
  await authService.insert({ id: u2, email: `${u2}@x.test`, name: u2, role: "customer", emailVerified: true } as never);
  const [w1] = await db.insert(wishlists).values({ user_id: u1 } as never).returning({ id: wishlists.id });
  const [w2] = await db.insert(wishlists).values({ user_id: u2 } as never).returning({ id: wishlists.id });
  const [w3] = await db.insert(wishlists).values({ token: `${TAG}-guesttoken` } as never).returning({ id: wishlists.id });

  const old = new Date(Date.now() - 40 * 86_400_000); // 40 days ago → outside BOTH windows
  const mid = new Date(Date.now() - 14 * 86_400_000); // 14 days ago → inside 30d, OUTSIDE 7d
  const fav = async (wid: string, pid: string, createdAt?: Date) =>
    db.insert(wishlist_items).values({ wishlist_id: wid, product_id: pid, ...(createdAt ? { created_at: createdAt } : {}) } as never);
  // p1 ×3 (one at 14d ago), p2 ×2, p3 ×1 (OLD), p4/p5/p6 ×1
  await fav(w1.id, p1); await fav(w2.id, p1); await fav(w3.id, p1, mid);
  await fav(w1.id, p2); await fav(w2.id, p2);
  await fav(w1.id, p3, old);
  await fav(w1.id, p4);
  await fav(w2.id, p5);
  await fav(w3.id, p6);

  // ── Demand stats over the isolated set (search tag matches the favtest product names) ──
  const s = await favoritesDemandStats(f({}));
  check("stats totalProducts = 6", s.totalProducts === 6);
  check("stats totalSaves = 9", s.totalSaves === 9);
  check("stats inStock = 5 (p2 out)", s.inStock === 5);
  check("stats outOfStock = 1 (p2)", s.outOfStock === 1);
  // Recency windows are DISTINGUISHED: p1's 14-day fav is in the 30d window but not the 7d one.
  check("stats recentSaves7 = 7 (p1's 14d + p3's 40d excluded)", s.recentSaves7 === 7);
  check("stats recentSaves30 = 8 (only p3's 40d excluded)", s.recentSaves30 === 8);
  check("stats recentSaves7 < recentSaves30 (7d window is tighter)", s.recentSaves7 < s.recentSaves30);

  // ── List filters ──
  const count = async (filter: FavoritesFilter) => (await listFavoritedProducts(filter, { limit: 50 })).items.length;
  check("list search → 6", (await count(f({}))) === 6);
  check("list stock=out → 1 (p2)", (await count(f({ stock: "out" }))) === 1);
  check("list stock=in → 5", (await count(f({ stock: "in" }))) === 5);
  check("list published=no → 1 (p3)", (await count(f({ published: "no" }))) === 1);
  check("list published=yes → 5", (await count(f({ published: "yes" }))) === 5);
  check("list category=cat → 5 (p5 has no primary category, excluded)", (await count(f({ categoryId: cat.id }))) === 5);
  check("list search=p1 → 1", (await count(f({ search: `${TAG} product p1` }))) === 1);

  // ── Ranking + enrichment ──
  const ranked = (await listFavoritedProducts(f({}), { limit: 50 })).items;
  check("ranked by favorites desc (p1=3 first, p2=2 second)", ranked[0].productId === p1 && ranked[0].count === 3 && ranked[1].productId === p2 && ranked[1].count === 2);
  const p2row = ranked.find((r) => r.productId === p2);
  check("p2 row: out of stock, category enriched", p2row != null && p2row.inStock === false && p2row.categoryName === `${TAG} Cat`);
  const p3row = ranked.find((r) => r.productId === p3);
  check("p3 row: unpublished, recent30 = 0 (old fav)", p3row != null && p3row.isPublished === false && p3row.recent30 === 0);
  const p5row = ranked.find((r) => r.productId === p5);
  check("p5 row: NO primary category → categoryName null, still listed", p5row != null && p5row.categoryName == null);
  const p6row = ranked.find((r) => r.productId === p6);
  check("p6 row: two categories → count NOT fan-out inflated (=1), primary shown", p6row != null && p6row.count === 1 && p6row.categoryName === `${TAG} Cat`);

  // ── Composition (global; live-product lists ≥ our seeded 2 members + 1 guest) ──
  const comp = await favoritesComposition();
  check("composition members ≥ 2, guests ≥ 1", comp.memberLists >= 2 && comp.guestLists >= 1);

  // ── favoritedCategories includes our tagged category ──
  const fc = await favoritedCategories();
  check("favoritedCategories includes the tagged category", fc.some((c) => c.id === cat.id));

  // ── Keyset pagination: 6 products, limit=2 so the count=1 tie (p3..p6) splits boundaries ──
  const seen: string[] = [];
  let cursor: string | undefined = undefined;
  let pages = 0;
  for (;;) {
    const pg = await listFavoritedProducts(f({}), { limit: 2, cursor });
    pages++;
    seen.push(...pg.items.map((r) => r.productId));
    if (!pg.nextCursor) break;
    cursor = pg.nextCursor;
    if (pages > 10) break;
  }
  check("pagination: 6 products over 3 pages of ≤2 (count tie split)", pages === 3 && seen.length === 6);
  check("pagination: every product appears exactly once", new Set(seen).size === 6);

  await cleanup();
  console.log(`\n=== favorites-filter: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  try { await cleanup(); } catch { /* best-effort */ }
  process.exit(1);
});
