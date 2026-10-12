import "server-only";

/**
 * Cross-surface promo-price PARITY (A-Z self-review). The storefront CARD/search/
 * feed price (via enrichProductSearchHits → buildLivePromotionDiscountMap →
 * discountedCents) must equal the PDP/cart/CHARGE price (resolveLivePromotion-
 * RowsForProducts → resolveProductDiscount) for the SAME product — including when
 * two auto-promos share display_priority, where the created_at tiebreak decides
 * the compound order. A regression here re-advertises a card price that differs
 * from the checkout charge (Merchant/ACP disapproval). Two stackable promos —
 * a 10% percent + a 5000-millime fixed — compound to DIFFERENT prices depending
 * on order (10% then −5000 = 85000; −5000 then 10% = 85500), so the tiebreak is
 * observable.
 *
 * Self-cleaning (`__parity…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/promo-card-charge-parity.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { categories } from "@/modules/catalog/category/schema";
import {
  promotionService,
  resolveLivePromotionRowsForProducts,
  getActiveDiscountForProduct,
  listNonDiscountableProductIds,
} from "@/modules/promotion";
import type { NewPromotionRow } from "@/modules/promotion/schema";
import { categoryService } from "@/modules/catalog/category/service";
import { productCategoryLinks } from "@/associations/catalog.service";
import { resolveProductDiscount } from "@/lib/promotions/product-discount";
import { enrichProductSearchHits } from "@/lib/api/products";
import { withLivePromoPricing } from "@/lib/promotions/live-product-price";
import type { Product } from "@/types/catalog";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__parity";

async function cleanup() {
  await db.execute(sql`delete from promotion_redemptions where promotion_id in (select id from promotions where name like ${TAG + "%"})`);
  await db.execute(sql`delete from promotions where name like ${TAG + "%"}`);
  await db.execute(sql`delete from product_categories where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from product_variants where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  // Detach any test parent link first (self-FK is SET NULL) then drop the rows.
  await db.execute(sql`update categories set parent_id = null where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from categories where slug like ${TAG + "%"}`);
}

async function main() {
  await cleanup();

  const [p] = await db
    .insert(products)
    .values({ slug: `${TAG}-p`, name: `${TAG} P`, price_cents: 100_000, stock_qty: 10, in_stock: true, is_published: true, is_discountable: true } as never)
    .returning({ id: products.id });

  // Two STACKABLE auto product-promos of EQUAL display_priority (default 0) but
  // distinct created_at, so the created_at tiebreak fully determines compound order.
  const earlier = new Date("2026-01-01T00:00:00.000Z");
  const later = new Date("2026-02-01T00:00:00.000Z");
  await promotionService.insert({
    name: `${TAG}-pct`, trigger_kind: "auto", scope: "product", scope_id: p.id,
    discount_type: "percent", discount_value: 10, is_stackable: true, is_active: true,
    display_priority: 0, created_at: earlier,
  } as NewPromotionRow);
  await promotionService.insert({
    name: `${TAG}-fixed`, trigger_kind: "auto", scope: "product", scope_id: p.id,
    discount_type: "fixed", discount_value: 5_000, is_stackable: true, is_active: true,
    display_priority: 0, created_at: later,
  } as NewPromotionRow);

  // CHARGE path (PDP/cart/checkout): resolve rows + resolveProductDiscount.
  const rowsMap = await resolveLivePromotionRowsForProducts([p.id]);
  const chargeRows = rowsMap.get(p.id)?.rows ?? [];
  const chargePrice = resolveProductDiscount(100_000, chargeRows)?.effectivePriceCents ?? 100_000;
  check("charge path compounds created_at ASC (10% then −5000 = 85000)", chargePrice === 85_000);

  // CARD path (cards/search/feed): enrichProductSearchHits mutates in place.
  const hits = [{ id: p.id, price_cents: 100_000, old_price_cents: null as number | null }];
  await enrichProductSearchHits(hits);
  check("card path applies a discount", hits[0].price_cents < 100_000);
  check("CARD price == CHARGE price (ordering parity)", hits[0].price_cents === chargePrice);

  // ── Category-scoped promo CASCADES to subcategories (expandCategoryIdsWithAncestors) ──
  // A category promo targeting a ROOT must reach a product filed only on a deep
  // CHILD, matching the storefront browsing model. Contrast: the non-discountable
  // opt-out is keyed on the product's DIRECT category links, NOT its ancestors.
  console.log("category promo cascade:");
  const [rootCat] = await db
    .insert(categories)
    .values({ slug: `${TAG}-cat-root`, name: `${TAG} cat root`, is_active: true } as never)
    .returning({ id: categories.id });
  const [leafCat] = await db
    .insert(categories)
    .values({ slug: `${TAG}-cat-leaf`, name: `${TAG} cat leaf`, parent_id: rootCat.id, is_active: true } as never)
    .returning({ id: categories.id });
  const [pc] = await db
    .insert(products)
    .values({ slug: `${TAG}-pc`, name: `${TAG} PC`, price_cents: 100_000, stock_qty: 5, in_stock: true, is_published: true, is_discountable: true } as never)
    .returning({ id: products.id });
  // Product filed ONLY on the leaf.
  await productCategoryLinks.set(pc.id, [leafCat.id], leafCat.id);
  // Auto promo scoped to the ROOT category.
  await promotionService.insert({
    name: `${TAG}-catpromo`, trigger_kind: "auto", scope: "category", scope_id: rootCat.id,
    discount_type: "percent", discount_value: 20, is_active: true,
  } as NewPromotionRow);

  const cascade = await getActiveDiscountForProduct({
    productId: pc.id,
    unitPriceCents: 100_000,
    categoryIds: [leafCat.id], // only the LEAF — the ancestor expansion must find the root promo
    brandIds: [],
  });
  check(
    "root-scoped promo cascades to a product on a deep child (−20% = 80000)",
    cascade?.effectivePriceCents === 80_000,
  );
  // A DIRECT root link resolves the same promo (sanity that the promo itself is live).
  const direct = await getActiveDiscountForProduct({
    productId: pc.id,
    unitPriceCents: 100_000,
    categoryIds: [rootCat.id],
    brandIds: [],
  });
  check("…and applies on a direct root link too", direct?.effectivePriceCents === 80_000);

  // Contrast — the discountable opt-out does NOT cascade from an ancestor: a
  // product on a discountable leaf under a NON-discountable root is still discountable.
  const [ndRoot] = await db
    .insert(categories)
    .values({ slug: `${TAG}-nd-root`, name: `${TAG} nd root`, is_active: true, is_discountable: false } as never)
    .returning({ id: categories.id });
  const [ndLeaf] = await db
    .insert(categories)
    .values({ slug: `${TAG}-nd-leaf`, name: `${TAG} nd leaf`, parent_id: ndRoot.id, is_active: true, is_discountable: true } as never)
    .returning({ id: categories.id });
  const [pnd] = await db
    .insert(products)
    .values({ slug: `${TAG}-pnd`, name: `${TAG} PND`, price_cents: 50_000, stock_qty: 5, in_stock: true, is_published: true, is_discountable: true } as never)
    .returning({ id: products.id });
  await productCategoryLinks.set(pnd.id, [ndLeaf.id], ndLeaf.id);
  const nd = await listNonDiscountableProductIds([pnd.id]);
  check(
    "non-discountable opt-out does NOT cascade from an ancestor (product on discountable leaf is discountable)",
    !nd.includes(pnd.id),
  );
  // Positive control: the SAME product filed directly on the non-discountable root IS blocked.
  await productCategoryLinks.set(pnd.id, [ndRoot.id], ndRoot.id);
  const nd2 = await listNonDiscountableProductIds([pnd.id]);
  check("…but a DIRECT link to a non-discountable category blocks it", nd2.includes(pnd.id));

  // ── Variant-only promo is VISIBLE on the single-product surface (migration 0173) ──
  // withLivePromoPricing is the shared helper the PDP mirrors. A promo pinned to ONE
  // variant of a variable product must discount THAT variant (and recompute the parent
  // "à partir de") — NOT be hidden because the product-level discount is null. This
  // locks the fixed PDP gate: don't gate the variable branch on getActiveDiscount-
  // ForProduct (no variantId → null for a variant-only promo).
  console.log("variant-only promo visibility (withLivePromoPricing / PDP mirror):");
  {
    const [pv] = await db.insert(products)
      .values({ slug: `${TAG}-pv`, name: `${TAG} PV`, price_cents: 100_000, stock_qty: 10, in_stock: true, is_published: true, is_discountable: true } as never)
      .returning({ id: products.id });
    const [va] = await db.insert(product_variants)
      .values({ product_id: pv.id, label: "A", price_cents: 100_000, display_order: 0, is_default: true } as never)
      .returning({ id: product_variants.id });
    const [vb] = await db.insert(product_variants)
      .values({ product_id: pv.id, label: "B", price_cents: 100_000, display_order: 1 } as never)
      .returning({ id: product_variants.id });
    const [vpromo] = await db.insert(await import("@/modules/promotion/schema").then((m) => m.promotions))
      .values({ name: `${TAG}-variant`, trigger_kind: "auto", scope: "targeted", scope_id: null, discount_type: "percent", discount_value: 30, is_active: true, display_priority: 0 } as NewPromotionRow)
      .returning({ id: products.id });
    await promotionService.setScopeTargets(vpromo.id, [{ target_type: "product", target_id: pv.id, variant_id: va.id }]);

    // Product-level discount is null (fail-closed) — the OLD PDP gate would hide the promo.
    const productLevel = await getActiveDiscountForProduct({ productId: pv.id, unitPriceCents: 100_000, categoryIds: [], brandIds: [] });
    check("product-level discount is null for a variant-only promo (fail-closed)", productLevel === null);

    const dto = {
      id: pv.id, priceCents: 100_000, price: 100,
      variants: [
        { id: va.id, label: "A", priceCents: 100_000, inStock: true, stockQty: null },
        { id: vb.id, label: "B", priceCents: 100_000, inStock: true, stockQty: null },
      ],
    } as unknown as Product;
    const priced = await withLivePromoPricing(dto, { id: pv.id, price_cents: 100_000 });
    const pa = priced.variants!.find((v) => v.id === va.id)!;
    const pb = priced.variants!.find((v) => v.id === vb.id)!;
    check("variant A shows the −30% promo (100000 → 70000)", pa.priceCents === 70_000 && pa.oldPriceCents === 100_000);
    check("variant B stays full price (100000, no struck-through)", pb.priceCents === 100_000 && !pb.oldPriceCents);
    check("parent « à partir de » recomputed from the discounted min (70000)", priced.priceCents === 70_000);
  }

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try { await cleanup(); } catch { /* best-effort */ }
    process.exit(1);
  })
  .then(() => process.exit(0));
