import "server-only";

/**
 * Catalog deletion fan-out (A–Z 09-23, phase 7 — p7-catalog-deletion-fanout).
 *
 *   B. Category / brand delete refuse while a live promotion (enabled, not
 *      deleted, not ended — a scheduled one counts) targets them; inactive /
 *      ended / deleted ones don't block.
 *   C. Deleting a NON-root category moves its product links to the parent in
 *      the same tx, keeping is_primary (merged OR onto an existing parent
 *      link, one primary per product), and emits product.updated
 *      ["categories"] for each moved product; the parent's tree lists them.
 *   D. Deleting a ROOT category leaves its links, but every link reader skips
 *      the tombstone: primaryCategoriesForProducts falls back to another live
 *      link (only when the primary was the dead one), categoryIdsForProducts /
 *      listForProduct / listProductIdsInCategory drop it, and its
 *      never-discountable flag stops blocking.
 *   E. A LEGACY promotion still scoped to a deleted category / brand stops
 *      matching (auto resolver + scoped coupons + card readers); a live scope
 *      keeps matching.
 *   F. Admin counts skip deleted products: the PUBLISHED brand count (sitemap
 *      empty-drop), wishlist globalStats / topCategories / public-profile item counts.
 *
 * Self-cleaning (rows tagged `zztest-cdf…`). Run ONLY against a throwaway DB:
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… EMAIL_PROVIDER=console \
 *     pnpm exec tsx --conditions=react-server src/lib/db/tests/catalog-deletion-fanout.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import {
  productBrandLink,
  productCategoryLinks,
} from "@/associations/catalog.service";
import { authService } from "@/modules/auth/service";
import { brands } from "@/modules/catalog/brand/schema";
import { categoryService } from "@/modules/catalog/category/service";
import { products } from "@/modules/catalog/product/schema";
import {
  listNonDiscountableProductIds,
  productsMatchingScope,
  promotionService,
  resolveLivePromotionRowsForProducts,
} from "@/modules/promotion";
import { countLivePromotionsForScope } from "@/modules/promotion/queries";
import type { NewPromotionRow } from "@/modules/promotion/schema";
import { wishlistService } from "@/modules/wishlist/service";
import { workflows } from "@/workflows";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const TAG = "zztest-cdf";
const ACTOR = { actorUserId: `${TAG}-actor` };

/** product.updated changedFields, keyed by product id. */
const updates = new Map<string, string[][]>();
bus.on("product.updated", (e) => {
  const list = updates.get(e.payload.productId) ?? [];
  list.push(e.payload.changedFields);
  updates.set(e.payload.productId, list);
});

async function cleanup() {
  const mine = sql`(select id from products where slug like ${TAG + "%"})`;
  await db.execute(sql`delete from wishlist_items where wishlist_id in (select id from wishlists where user_id like ${TAG + "%"} or token like ${TAG + "%"})`);
  await db.execute(sql`delete from wishlists where user_id like ${TAG + "%"} or token like ${TAG + "%"}`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
  await db.execute(sql`delete from promotion_redemptions where promotion_id in (select id from promotions where name like ${TAG + "%"})`);
  await db.execute(sql`delete from promotions where name like ${TAG + "%"}`);
  await db.execute(sql`delete from stock_movements where product_id in ${mine}`);
  await db.execute(sql`delete from stock_levels where product_id in ${mine}`);
  await db.execute(sql`delete from product_categories where product_id in ${mine}`);
  await db.execute(sql`delete from product_brands where product_id in ${mine}`);
  await db.execute(sql`delete from product_variants where product_id in ${mine}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from categories where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from brands where slug like ${TAG + "%"}`);
}

async function mkProduct(suffix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const [r] = await db
    .insert(products)
    .values({ slug: `${TAG}-${suffix}`, name: `${TAG} ${suffix}`, price_cents: 100_000, ...extra } as never)
    .returning({ id: products.id });
  return r.id;
}

async function mkCategory(suffix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const row = await categoryService.insert({
    name: `${TAG} ${suffix}`,
    slug: `${TAG}-${suffix}`,
    ...extra,
  } as never);
  return row.id;
}

async function mkPromo(suffix: string, extra: Partial<NewPromotionRow>): Promise<string> {
  const row = await promotionService.insert({
    name: `${TAG}-${suffix}`,
    trigger_kind: "auto",
    discount_type: "percent",
    discount_value: 20,
    is_stackable: true,
    is_active: true,
    ...extra,
  } as NewPromotionRow);
  return row.id;
}

/** Raw link rows (tombstoned categories included) for one product. */
async function rawLinks(productId: string) {
  const r = await db.execute<{ category_id: string; is_primary: boolean }>(
    sql`select category_id, is_primary from product_categories where product_id = ${productId}`,
  );
  return r.rows;
}

const DAY = 24 * 60 * 60 * 1000;

async function main() {
  await cleanup();

  // ── B. Delete guards vs live promotions ──────────────────────────────────
  const root = await mkCategory("root", { tax_rate_bps: 700 });
  const leaf = await mkCategory("leaf", { parent_id: root });
  const side = await mkCategory("side", { parent_id: root });

  const promoLeaf = await mkPromo("leaf", { scope: "category", scope_id: leaf });
  const refused = await workflows.catalog.deleteCategory({ categoryId: leaf }, ACTOR);
  check(
    "B1: category targeted by an active promotion → delete refused (conflict)",
    !refused.ok && refused.error === "conflict" && refused.message.includes("1 promotion(s)"),
  );
  check("B2: …and the category is still live", (await categoryService.findById(leaf)) != null);
  await promotionService.update(promoLeaf, { is_active: false });
  await mkPromo("leaf-ended", {
    scope: "category",
    scope_id: leaf,
    starts_at: new Date(Date.now() - 2 * DAY),
    ends_at: new Date(Date.now() - DAY),
  });
  check("B3: inactive + ended promotions don't count", (await countLivePromotionsForScope("category", leaf)) === 0);
  const promoFuture = await mkPromo("side-future", {
    scope: "category",
    scope_id: side,
    starts_at: new Date(Date.now() + DAY),
  });
  check("B4: a scheduled (not yet started) promotion counts", (await countLivePromotionsForScope("category", side)) === 1);
  await promotionService.softDelete(promoFuture);
  check("B5: a deleted promotion doesn't", (await countLivePromotionsForScope("category", side)) === 0);

  // ── C. Non-root delete moves the product links to the parent ─────────────
  const p1 = await mkProduct("c1"); // leaf (primary)
  const p2 = await mkProduct("c2"); // leaf + root (primary)
  const p3 = await mkProduct("c3"); // leaf (primary) + root
  const p4 = await mkProduct("c4"); // leaf (primary) + side
  await productCategoryLinks.set(p1, [leaf], leaf);
  await productCategoryLinks.set(p2, [leaf, root], root);
  await productCategoryLinks.set(p3, [leaf, root], leaf);
  await productCategoryLinks.set(p4, [leaf, side], leaf);
  updates.clear();
  const delLeaf = await workflows.catalog.deleteCategory({ categoryId: leaf }, ACTOR);
  check("C1: deleteCategory(leaf) ok once no live promotion targets it", delLeaf.ok);
  const onLeaf = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from product_categories where category_id = ${leaf}`,
  );
  check("C2: no product link is left on the tombstone", Number(onLeaf.rows[0]?.n) === 0);
  const l1 = await rawLinks(p1);
  check("C3: leaf-only product → one PRIMARY link on the parent", l1.length === 1 && l1[0].category_id === root && l1[0].is_primary);
  const l2 = await rawLinks(p2);
  check("C4: already on the parent (primary) → one row, still primary", l2.length === 1 && l2[0].category_id === root && l2[0].is_primary);
  const l3 = await rawLinks(p3);
  check("C5: primary on the leaf + plain parent link → merged, primary", l3.length === 1 && l3[0].category_id === root && l3[0].is_primary);
  const l4 = await rawLinks(p4);
  check(
    "C6: other links untouched, primary moved to the parent",
    l4.length === 2 &&
      l4.some((l) => l.category_id === root && l.is_primary) &&
      l4.some((l) => l.category_id === side && !l.is_primary),
  );
  const primaries = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from product_categories
      where product_id in (${p1}, ${p2}, ${p3}, ${p4}) and is_primary
  `);
  check("C7: exactly one primary per moved product", Number(primaries.rows[0]?.n) === 4);
  const prim = await productCategoryLinks.primaryCategoriesForProducts([p1, p2, p3, p4]);
  check("C8: TVA/warranty chain now starts at the parent for every moved product", [p1, p2, p3, p4].every((p) => prim.get(p) === root));
  const tree = await productCategoryLinks.listProductIdsInCategoryTree(root);
  check("C9: the parent's listing still carries them", [p1, p2, p3, p4].every((p) => tree.includes(p)));
  check(
    "C10: product.updated [\"categories\"] emitted per moved product",
    [p1, p2, p3, p4].every((p) => (updates.get(p) ?? []).some((f) => f.includes("categories"))),
  );

  // ── D. Root delete: links stay, readers skip the tombstone ───────────────
  const root2 = await mkCategory("root2", { is_discountable: false });
  const p5 = await mkProduct("d1"); // root2 (primary) + side
  const p6 = await mkProduct("d2"); // side, NO primary
  await productCategoryLinks.set(p5, [root2, side], root2);
  await productCategoryLinks.set(p6, [side]);
  check("D0: before the delete, root2's never-discountable flag blocks p5", (await listNonDiscountableProductIds([p5])).includes(p5));
  const delRoot2 = await workflows.catalog.deleteCategory({ categoryId: root2 }, ACTOR);
  check("D1: deleteCategory(root) ok", delRoot2.ok);
  check("D2: a root's links are left in place", (await rawLinks(p5)).length === 2);
  const prim2 = await productCategoryLinks.primaryCategoriesForProducts([p5, p6]);
  check("D3: dead primary → falls back to the other LIVE link", prim2.get(p5) === side);
  check("D4: a product that never had a primary stays absent (unchanged)", !prim2.has(p6));
  const cats5 = await productCategoryLinks.categoryIdsForProducts([p5]);
  check("D5: categoryIdsForProducts drops the tombstone", JSON.stringify(cats5.get(p5)) === JSON.stringify([side]));
  const list5 = await productCategoryLinks.listForProduct(p5);
  check("D6: listForProduct drops the tombstone", list5.length === 1 && list5[0].category_id === side);
  check("D7: listProductIdsInCategory(deleted) is empty", (await productCategoryLinks.listProductIdsInCategory(root2)).length === 0);
  check("D8: the deleted category's never-discountable flag no longer blocks", !(await listNonDiscountableProductIds([p5])).includes(p5));

  // ── E. Legacy promotions on deleted targets stop matching ────────────────
  await mkPromo("root2-legacy", { scope: "category", scope_id: root2 });
  const promoSide = await mkPromo("side-live", { scope: "category", scope_id: side, discount_value: 10 });
  const resolved5 = await resolveLivePromotionRowsForProducts([p5]);
  const ids5 = (resolved5.get(p5)?.rows ?? []).map((r) => r.id);
  check("E1: auto resolver ignores the deleted category's promotion, keeps the live one", ids5.length === 1 && ids5[0] === promoSide);
  check("E2: a category coupon on the deleted category matches nothing", (await productsMatchingScope("category", root2, [p5])).size === 0);
  check("E3: …while one on a live category still matches", (await productsMatchingScope("category", side, [p5])).has(p5));

  const [brand] = await db
    .insert(brands)
    .values({ name: `${TAG} brand`, slug: `${TAG}-brand` } as never)
    .returning({ id: brands.id });
  const p7 = await mkProduct("e1");
  await productBrandLink.set(p7, brand.id);
  const promoBrand = await mkPromo("brand", { scope: "brand", scope_id: brand.id });
  const refusedBrand = await workflows.catalog.deleteBrand({ brandId: brand.id }, ACTOR);
  check(
    "E4: brand targeted by an active promotion → delete refused (conflict)",
    !refusedBrand.ok && refusedBrand.error === "conflict" && refusedBrand.message.includes("marque"),
  );
  await promotionService.update(promoBrand, { is_active: false });
  const delBrand = await workflows.catalog.deleteBrand({ brandId: brand.id }, ACTOR);
  check("E5: deleteBrand ok once the promotion is disabled", delBrand.ok);
  // Simulate a legacy promotion re-enabled on the now-deleted brand.
  await promotionService.update(promoBrand, { is_active: true });
  const resolved7 = await resolveLivePromotionRowsForProducts([p7]);
  check("E6: auto resolver ignores a promotion on a deleted brand", (resolved7.get(p7)?.rows ?? []).length === 0);
  check("E7: a brand coupon on the deleted brand matches nothing", (await productsMatchingScope("brand", brand.id, [p7])).size === 0);
  check(
    "E8: brand readers skip the tombstone (findBrandId / listProductIdsForBrand)",
    (await productBrandLink.findBrandId(p7)) === null &&
      (await productBrandLink.listProductIdsForBrand(brand.id)).length === 0 &&
      !(await productBrandLink.findBrandIdsForProducts([p7])).has(p7),
  );

  // ── F. Admin counts skip deleted products ────────────────────────────────
  const pLive = await mkProduct("f1");
  const pGone = await mkProduct("f2");
  await productCategoryLinks.set(pLive, [side], side);
  await productCategoryLinks.set(pGone, [side], side);
  const statsBefore = await wishlistService.globalStats();
  const user = `${TAG}-user`;
  await authService.insert({ id: user, email: `${user}@example.test`, name: user, role: "customer" } as never);
  const w = await wishlistService.createForUser(user);
  await wishlistService.addItem(w.id, pLive);
  await wishlistService.addItem(w.id, pGone);
  const pub = await wishlistService.setPublicProfile(user, { isPublic: true, slug: `${TAG}-pub`, displayName: "CDF" });
  const del = await workflows.catalog.deleteProduct({ productId: pGone }, ACTOR);
  check("F0: fixtures ready", del.ok && pub.ok);
  // F1d: the PUBLISHED-only brand count drives the sitemap empty-drop (a 0-published
  // brand is dropped so the sitemap never advertises a thin page). It differs from the
  // admin counts by the `is_published = true` filter — the branch the admin fixtures
  // (pLive/pGone are unpublished) don't exercise. countPublishedProductsForBrands.
  const [brandRow] = await db
    .insert(brands)
    .values({ name: `${TAG} brand`, slug: `${TAG}-brand-cnt` } as never)
    .returning({ id: brands.id });
  const pbPub = await mkProduct("f5", { is_published: true, published_at: sql`now()` });
  const pbDel = await mkProduct("f6", { is_published: true, published_at: sql`now()` });
  await productBrandLink.set(pbPub, brandRow.id);
  await productBrandLink.set(pbDel, brandRow.id);
  await workflows.catalog.deleteProduct({ productId: pbDel }, ACTOR);
  check(
    "F1d: PUBLISHED brand count = live published only (excludes the deleted one)",
    (await productBrandLink.countPublishedProductsForBrands([brandRow.id])).get(brandRow.id) === 1,
  );
  const statsAfter = await wishlistService.globalStats();
  check(
    "F2: wishlist globalStats counts only the live favorite",
    statsAfter.totalItems - statsBefore.totalItems === 1 && statsAfter.products - statsBefore.products === 1,
  );
  const top = await wishlistService.topCategories(100);
  check("F3: topCategories counts only the live favorite", top.find((c) => c.categoryId === side)?.count === 1);
  const profiles = await wishlistService.listPublicProfiles({ q: `${TAG}-pub` });
  check("F4: public-profile item count skips the deleted product", profiles.find((p) => p.id === w.id)?.items === 1);

  await cleanup();

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* best-effort cleanup */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
