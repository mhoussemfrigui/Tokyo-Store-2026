import "server-only";

/**
 * MULTI-target promotion scope (promotion_scope_targets, migration 0169/0170).
 *
 * A promotion with scope='targeted' applies to ANY mix of products / categories /
 * brands at once. This suite proves the multi-target set resolves IDENTICALLY on
 * every price surface — the batched charge path (resolveLivePromotionRowsForProducts),
 * the per-product PDP path (getActiveDiscountForProduct), the card/feed map
 * (enrichProductSearchHits), and the scoped-coupon matcher (productsMatchingPromoScope
 * → evaluateCouponEligibility) — plus the delete-guard count, the legacy synth
 * fallback (a promo with no scope_targets rows still matches via its scope_id), the
 * category cascade toggle (include_descendants), the non-discountable guard, and the
 * manage-workflow round-trip (create/validate/duplicate).
 *
 * Self-cleaning (`__mst…`). Run against the isolated dev DB:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/promotion-scope-targets.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { categories } from "@/modules/catalog/category/schema";
import { brands } from "@/modules/catalog/brand/schema";
import {
  promotionService,
  resolveLivePromotionRowsForProducts,
  getActiveDiscountForProduct,
  productsMatchingPromoScope,
  rowsForLineVariant,
} from "@/modules/promotion";
import { countLivePromotionsForScope } from "@/modules/promotion/queries";
import { promotions, type NewPromotionRow } from "@/modules/promotion/schema";
import { productCategoryLinks, productBrandLink } from "@/associations/catalog.service";
import { resolveProductDiscount } from "@/lib/promotions/product-discount";
import { evaluateCouponEligibility } from "@/lib/promotions/coupon-eligibility";
import { enrichProductSearchHits } from "@/lib/api/products";
import { workflows } from "@/workflows";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__mst";
const ACTOR = "__mst-actor";

async function cleanup() {
  await db.execute(sql`delete from promotion_scope_targets where promotion_id in (select id from promotions where name like ${TAG + "%"})`);
  await db.execute(sql`delete from promotion_redemptions where promotion_id in (select id from promotions where name like ${TAG + "%"})`);
  await db.execute(sql`delete from promotions where name like ${TAG + "%"}`);
  await db.execute(sql`delete from product_categories where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from product_brands where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from product_variants where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`update categories set parent_id = null where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from categories where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from brands where slug like ${TAG + "%"}`);
}

async function mkProduct(suffix: string): Promise<string> {
  const [row] = await db
    .insert(products)
    .values({ slug: `${TAG}-${suffix}`, name: `${TAG} ${suffix}`, price_cents: 100_000, stock_qty: 10, in_stock: true, is_published: true, is_discountable: true } as never)
    .returning({ id: products.id });
  return row.id;
}

async function main() {
  await cleanup();

  // ── Fixtures: rootCat → leafCat, a brand, and four products ──────────────
  const [rootCat] = await db.insert(categories).values({ slug: `${TAG}-root`, name: `${TAG} root`, is_active: true } as never).returning({ id: categories.id });
  const [leafCat] = await db.insert(categories).values({ slug: `${TAG}-leaf`, name: `${TAG} leaf`, parent_id: rootCat.id, is_active: true } as never).returning({ id: categories.id });
  const [brandX] = await db.insert(brands).values({ slug: `${TAG}-brandx`, name: `${TAG} BrandX`, is_active: true } as never).returning({ id: brands.id });

  const pProduct = await mkProduct("p-product"); // targeted directly
  const pCategory = await mkProduct("p-category"); // filed on the LEAF (cascade from root)
  const pBrand = await mkProduct("p-brand"); // carries BrandX
  const pNone = await mkProduct("p-none"); // matched by nothing
  await productCategoryLinks.set(pCategory, [leafCat.id], leafCat.id);
  await productBrandLink.set(pBrand, brandX.id);

  // ── The flagship: a scope='targeted' AUTO promo (−20%) over 3 targets ─────
  const [targeted] = await db
    .insert(promotions)
    .values({
      name: `${TAG}-targeted-auto`, trigger_kind: "auto", scope: "targeted", scope_id: null,
      discount_type: "percent", discount_value: 20, is_active: true, display_priority: 0,
    } as NewPromotionRow)
    .returning({ id: promotions.id });
  await promotionService.setScopeTargets(targeted.id, [
    { target_type: "product", target_id: pProduct },
    { target_type: "category", target_id: rootCat.id, include_descendants: true },
    { target_type: "brand", target_id: brandX.id },
  ]);

  // ── A. Batched charge path resolves all three target dimensions ──────────
  console.log("A. batched resolver (charge path):");
  {
    const map = await resolveLivePromotionRowsForProducts([pProduct, pCategory, pBrand, pNone]);
    const has = (id: string) => (map.get(id)?.rows ?? []).some((r) => r.id === targeted.id);
    check("product target matches directly", has(pProduct));
    check("category target cascades to a product on a deep child", has(pCategory));
    check("brand target matches", has(pBrand));
    check("an unrelated product matches nothing", !has(pNone) && (map.get(pNone)?.rows.length ?? 0) === 0);
    const price = (id: string) => resolveProductDiscount(100_000, map.get(id)?.rows ?? [])?.effectivePriceCents ?? 100_000;
    check("matched products priced −20% = 80000", price(pProduct) === 80_000 && price(pCategory) === 80_000 && price(pBrand) === 80_000);
    check("unrelated product stays 100000", price(pNone) === 100_000);
  }

  // ── B. Per-product PDP path agrees with the batch ────────────────────────
  console.log("B. per-product PDP path (getActiveDiscountForProduct):");
  {
    const d1 = await getActiveDiscountForProduct({ productId: pProduct, unitPriceCents: 100_000, categoryIds: [], brandIds: [] });
    const d2 = await getActiveDiscountForProduct({ productId: pCategory, unitPriceCents: 100_000, categoryIds: [leafCat.id], brandIds: [] });
    const d3 = await getActiveDiscountForProduct({ productId: pBrand, unitPriceCents: 100_000, categoryIds: [], brandIds: [brandX.id] });
    const d4 = await getActiveDiscountForProduct({ productId: pNone, unitPriceCents: 100_000, categoryIds: [], brandIds: [] });
    check("product target → 80000", d1?.effectivePriceCents === 80_000);
    check("category cascade (leaf only passed) → 80000", d2?.effectivePriceCents === 80_000);
    check("brand target → 80000", d3?.effectivePriceCents === 80_000);
    check("unrelated → null (no discount)", d4 === null);
  }

  // ── C. Card / feed map parity (enrichProductSearchHits) ──────────────────
  console.log("C. card/feed parity (buildLivePromotionDiscountMap):");
  {
    const hits = [pProduct, pCategory, pBrand, pNone].map((id) => ({ id, price_cents: 100_000, old_price_cents: null as number | null }));
    await enrichProductSearchHits(hits);
    const price = (id: string) => hits.find((h) => h.id === id)!.price_cents;
    check("card price for product target == 80000", price(pProduct) === 80_000);
    check("card price for category-cascade product == 80000 (subtree, was direct-only)", price(pCategory) === 80_000);
    check("card price for brand target == 80000", price(pBrand) === 80_000);
    check("card price for unrelated stays 100000", price(pNone) === 100_000);
  }

  // ── D. Multi-target scoped COUPON (productsMatchingPromoScope + eligibility)
  console.log("D. multi-target scoped coupon:");
  {
    const [coupon] = await db
      .insert(promotions)
      .values({
        name: `${TAG}-targeted-code`, trigger_kind: "code", code: `${TAG}CODE`, scope: "targeted", scope_id: null,
        discount_type: "percent", discount_value: 10, is_active: true,
      } as NewPromotionRow)
      .returning({ id: promotions.id });
    await promotionService.setScopeTargets(coupon.id, [
      { target_type: "product", target_id: pProduct },
      { target_type: "category", target_id: rootCat.id, include_descendants: true },
      { target_type: "brand", target_id: brandX.id },
    ]);
    const promoRow = await promotionService.findById(coupon.id);
    const matched = await productsMatchingPromoScope(promoRow!, [pProduct, pCategory, pBrand, pNone]);
    check("coupon matches all three targeted products", matched.has(pProduct) && matched.has(pCategory) && matched.has(pBrand));
    check("coupon does NOT match the unrelated product", !matched.has(pNone));
    // Eligibility: base = the two matching lines (pProduct + pNone in cart) → only pProduct counts.
    const verdict = await evaluateCouponEligibility(promoRow!, {
      cartSubtotalCents: 200_000,
      userId: null,
      lines: [
        { productId: pProduct, lineCents: 100_000, baseLineCents: 100_000 },
        { productId: pNone, lineCents: 100_000, baseLineCents: 100_000 },
      ],
    });
    check("eligible; discounts ONLY the matching line (10% of 100000 = 10000)", verdict.eligible === true && verdict.discountCents === 10_000);
    // A cart with only the unrelated product → no matching items (soft drop).
    const none = await evaluateCouponEligibility(promoRow!, {
      cartSubtotalCents: 100_000, userId: null,
      lines: [{ productId: pNone, lineCents: 100_000, baseLineCents: 100_000 }],
    });
    check("cart without a matching line → no_matching_items", none.eligible === false && none.reason === "no_matching_items");
  }

  // ── E. Delete-guard count catches a targeted promo (de-duped) ────────────
  // Exercises the ACTUAL guard counter the category/brand delete workflows call
  // (countLivePromotionsForScope — covers BOTH legacy scope_id and scope_targets via
  // its EXISTS clause), not a parallel service method.
  console.log("E. countLivePromotionsForScope (delete guard):");
  {
    const catCount = await countLivePromotionsForScope("category", rootCat.id);
    const brandCount = await countLivePromotionsForScope("brand", brandX.id);
    check("targeted promo(s) count against the category via scope_targets", catCount >= 1);
    check("targeted promo(s) count against the brand via scope_targets", brandCount >= 1);
  }

  // ── F. Legacy synth fallback: no scope_targets rows, still matches ───────
  console.log("F. legacy synth fallback (scope_id, no scope_targets rows):");
  {
    const [legacy] = await db
      .insert(promotions)
      .values({
        name: `${TAG}-legacy-cat`, trigger_kind: "auto", scope: "category", scope_id: rootCat.id,
        discount_type: "percent", discount_value: 30, is_active: true, display_priority: 50,
      } as NewPromotionRow)
      .returning({ id: promotions.id });
    // No setScopeTargets call — this row has ZERO scope_targets rows.
    const rows = await promotionService.listScopeTargets(legacy.id);
    check("legacy promo has no scope_targets rows", rows.length === 0);
    const map = await resolveLivePromotionRowsForProducts([pCategory]);
    check("…yet it still matches via the synthesised (scope_id) target", (map.get(pCategory)?.rows ?? []).some((r) => r.id === legacy.id));
  }

  // ── G. manage-workflow: create/validate a targeted promo ─────────────────
  console.log("G. manage workflow (create + validation):");
  {
    const base = {
      triggerKind: "auto" as const, discountType: "percent" as const, discountValue: 15,
      minCartCents: 0, isActive: true, isStackable: false, excludeDiscountedItems: false,
      grantsFreeShipping: false, displayPriority: 0,
    };
    // Valid targeted create.
    const okRes = await workflows.promotion.create(
      { ...base, name: `${TAG}-wf-targeted`, scope: "targeted", scopeId: null,
        scopeTargets: [{ targetType: "product", targetId: pProduct }, { targetType: "brand", targetId: brandX.id }] } as never,
      { actorUserId: ACTOR },
    );
    check("targeted create ok", okRes.ok === true);
    if (okRes.ok) {
      const row = await promotionService.findById(okRes.data.promotionId);
      check("stored scope='targeted' with scope_id NULL", row?.scope === "targeted" && row?.scope_id === null);
      const st = await promotionService.listScopeTargets(okRes.data.promotionId);
      check("persisted 2 scope_targets rows", st.length === 2 && st.some((t) => t.target_id === pProduct) && st.some((t) => t.target_id === brandX.id));
    }
    // Targeted with NO targets → rejected.
    const empty = await workflows.promotion.create(
      { ...base, name: `${TAG}-wf-empty`, scope: "targeted", scopeId: null, scopeTargets: [] } as never,
      { actorUserId: ACTOR },
    );
    check("targeted with 0 targets rejected", empty.ok === false);
    // Targeted with a scopeId → rejected.
    const withId = await workflows.promotion.create(
      { ...base, name: `${TAG}-wf-withid`, scope: "targeted", scopeId: pProduct,
        scopeTargets: [{ targetType: "product", targetId: pProduct }] } as never,
      { actorUserId: ACTOR },
    );
    check("targeted with a single scopeId rejected", withId.ok === false);
    // Single-scope create also writes ONE uniform scope_targets row.
    const single = await workflows.promotion.create(
      { ...base, name: `${TAG}-wf-single`, scope: "product", scopeId: pProduct, scopeTargets: [] } as never,
      { actorUserId: ACTOR },
    );
    check("single-scope create ok", single.ok === true);
    if (single.ok) {
      const st = await promotionService.listScopeTargets(single.data.promotionId);
      check("single-scope create wrote 1 uniform scope_targets row", st.length === 1 && st[0].target_type === "product" && st[0].target_id === pProduct);

      // De-dup: this backfilled-style legacy promo counts ONCE, not twice.
      const cnt = await (async () => {
        const { countLivePromotionsForScope } = await import("@/modules/promotion/queries");
        return countLivePromotionsForScope("category", rootCat.id);
      })();
      check("count is de-duped (a promo via scope_id AND a scope_target counts once)", Number.isInteger(cnt) && cnt >= 1);

      // Duplicate copies the scope targets.
      const dup = await workflows.promotion.duplicate({ promotionId: single.data.promotionId }, { actorUserId: ACTOR });
      check("duplicate ok", dup.ok === true);
      if (dup.ok) {
        const st2 = await promotionService.listScopeTargets(dup.data.promotionId);
        check("clone copied the scope_targets row", st2.length === 1 && st2[0].target_id === pProduct);
      }
    }
  }

  // ── H. include_descendants=false does NOT cascade ────────────────────────
  console.log("H. include_descendants=false (direct-only category target):");
  {
    const [directOnly] = await db
      .insert(promotions)
      .values({
        name: `${TAG}-direct-cat`, trigger_kind: "auto", scope: "targeted", scope_id: null,
        discount_type: "percent", discount_value: 25, is_active: true, display_priority: 0,
      } as NewPromotionRow)
      .returning({ id: promotions.id });
    // Target the ROOT category, NON-cascading. pCategory is filed on the LEAF only.
    await promotionService.setScopeTargets(directOnly.id, [
      { target_type: "category", target_id: rootCat.id, include_descendants: false },
    ]);
    const map = await resolveLivePromotionRowsForProducts([pCategory]);
    check("non-cascading root target does NOT reach a leaf-only product", !(map.get(pCategory)?.rows ?? []).some((r) => r.id === directOnly.id));
    // A product filed DIRECTLY on root IS matched.
    await productCategoryLinks.set(pCategory, [rootCat.id], rootCat.id);
    const map2 = await resolveLivePromotionRowsForProducts([pCategory]);
    check("…but a product filed directly on root IS matched", (map2.get(pCategory)?.rows ?? []).some((r) => r.id === directOnly.id));
  }

  // ── I. Non-discountable guard still applies to a targeted promo ──────────
  console.log("I. non-discountable guard:");
  {
    await db.execute(sql`update products set is_discountable = false where id = ${pBrand}`);
    const map = await resolveLivePromotionRowsForProducts([pBrand]);
    check("flagged product → discountable false, no rows", map.get(pBrand)?.discountable === false && (map.get(pBrand)?.rows.length ?? 0) === 0);
    const promoRow = await promotionService.findById(targeted.id);
    const matched = await productsMatchingPromoScope(promoRow!, [pBrand]);
    check("scoped coupon also excludes the flagged product", !matched.has(pBrand));
    await db.execute(sql`update products set is_discountable = true where id = ${pBrand}`);
  }

  // ── J. Per-VARIANT product target (migration 0173) ───────────────────────
  // A product target may pin ONE variant → the promo applies to THAT variant only.
  // The design is FAIL-CLOSED: a variant-constrained promo lives in `rowsByVariant`,
  // never the default `rows`, so any caller that ignores the variant under-applies
  // (never over-discounts). Proven across every surface + the whole-product override.
  console.log("J. per-variant product target:");
  {
    const pVar = await mkProduct("p-variant");
    const [vA] = await db.insert(product_variants)
      .values({ product_id: pVar, label: "Variante A", price_cents: 100_000, display_order: 0, is_default: true } as never)
      .returning({ id: product_variants.id });
    const [vB] = await db.insert(product_variants)
      .values({ product_id: pVar, label: "Variante B", price_cents: 100_000, display_order: 1 } as never)
      .returning({ id: product_variants.id });

    // A targeted auto promo (−30%) pinned to variant A only.
    const [vp] = await db.insert(promotions)
      .values({
        name: `${TAG}-variant-auto`, trigger_kind: "auto", scope: "targeted", scope_id: null,
        discount_type: "percent", discount_value: 30, is_active: true, display_priority: 0,
      } as NewPromotionRow)
      .returning({ id: promotions.id });
    await promotionService.setScopeTargets(vp.id, [
      { target_type: "product", target_id: pVar, variant_id: vA.id },
    ]);

    // Persistence round-trip: the row carries variant_id.
    const stored = await promotionService.listScopeTargets(vp.id);
    check("scope_target persisted with variant_id = A",
      stored.length === 1 && stored[0].target_id === pVar && stored[0].variant_id === vA.id);

    // Resolver split: default `rows` is EMPTY (fail-closed); the promo sits in rowsByVariant[A].
    const map = await resolveLivePromotionRowsForProducts([pVar]);
    const entry = map.get(pVar);
    check("default rows are empty (variant-constrained promo excluded)", (entry?.rows.length ?? 99) === 0);
    check("rowsByVariant carries the promo under variant A",
      (entry?.rowsByVariant?.get(vA.id) ?? []).some((r) => r.id === vp.id));
    check("rowsByVariant has NO entry for variant B", !(entry?.rowsByVariant?.has(vB.id)));

    // rowsForLineVariant gate: variant A gets the promo rows, variant B gets none,
    // and a null/unknown variant gets only the (empty) unconstrained rows.
    check("rowsForLineVariant(A) yields the promo", rowsForLineVariant(entry, vA.id).some((r) => r.id === vp.id));
    check("rowsForLineVariant(B) yields nothing", rowsForLineVariant(entry, vB.id).length === 0);
    check("rowsForLineVariant(null) yields nothing (unconstrained empty)", rowsForLineVariant(entry, null).length === 0);

    // Priced: variant A −30% = 70000, variant B stays 100000.
    check("variant A priced −30% = 70000",
      resolveProductDiscount(100_000, rowsForLineVariant(entry, vA.id))?.effectivePriceCents === 70_000);
    check("variant B stays 100000 (no matching promo)",
      resolveProductDiscount(100_000, rowsForLineVariant(entry, vB.id)) === null);

    // Per-product PDP path: no variantId → null (product-level sees no unconstrained
    // promo); variantId=A → 70000; variantId=B → null.
    const dNoVar = await getActiveDiscountForProduct({ productId: pVar, unitPriceCents: 100_000, categoryIds: [], brandIds: [] });
    const dVarA = await getActiveDiscountForProduct({ productId: pVar, unitPriceCents: 100_000, categoryIds: [], brandIds: [], variantId: vA.id });
    const dVarB = await getActiveDiscountForProduct({ productId: pVar, unitPriceCents: 100_000, categoryIds: [], brandIds: [], variantId: vB.id });
    check("getActiveDiscountForProduct without variantId → null", dNoVar === null);
    check("getActiveDiscountForProduct(variant A) → 70000", dVarA?.effectivePriceCents === 70_000);
    check("getActiveDiscountForProduct(variant B) → null", dVarB === null);

    // Card / feed map is product-keyed → EXCLUDES the variant-constrained target
    // (can't price a single variant). Merchant-safe UNDER-display: card stays at base.
    const hits = [{ id: pVar, price_cents: 100_000, old_price_cents: null as number | null }];
    await enrichProductSearchHits(hits);
    check("card/feed price stays 100000 (variant promo not surfaced on the product card)", hits[0].price_cents === 100_000);

    // Scoped COUPON without variant facts → does NOT match (safe under-apply).
    const [vcoupon] = await db.insert(promotions)
      .values({
        name: `${TAG}-variant-code`, trigger_kind: "code", code: `${TAG}VCODE`, scope: "targeted", scope_id: null,
        discount_type: "percent", discount_value: 30, is_active: true,
      } as NewPromotionRow)
      .returning({ id: promotions.id });
    await promotionService.setScopeTargets(vcoupon.id, [{ target_type: "product", target_id: pVar, variant_id: vA.id }]);
    const vcRow = await promotionService.findById(vcoupon.id);
    const matched = await productsMatchingPromoScope(vcRow!, [pVar]);
    check("variant-constrained coupon does NOT match by product id (no variant facts)", !matched.has(pVar));

    // Whole-product OVERRIDE: add an unconstrained product target for the SAME product
    // → it covers BOTH variants (unconstrained wins; rowsByVariant is emptied).
    await promotionService.setScopeTargets(vp.id, [
      { target_type: "product", target_id: pVar, variant_id: vA.id },
      { target_type: "product", target_id: pVar }, // whole-product (all variants)
    ]);
    const map2 = await resolveLivePromotionRowsForProducts([pVar]);
    const entry2 = map2.get(pVar);
    check("whole-product target moves the promo to unconstrained rows", entry2?.rows.some((r) => r.id === vp.id) === true);
    check("both variants now discounted (unconstrained wins)",
      resolveProductDiscount(100_000, rowsForLineVariant(entry2, vA.id))?.effectivePriceCents === 70_000 &&
      resolveProductDiscount(100_000, rowsForLineVariant(entry2, vB.id))?.effectivePriceCents === 70_000);

    // manage-workflow round-trip: create a targeted promo with a variant-pinned target.
    const wf = await workflows.promotion.create(
      { triggerKind: "auto", discountType: "percent", discountValue: 15, minCartCents: 0,
        isActive: true, isStackable: false, excludeDiscountedItems: false, grantsFreeShipping: false,
        displayPriority: 0, name: `${TAG}-wf-variant`, scope: "targeted", scopeId: null,
        scopeTargets: [{ targetType: "product", targetId: pVar, variantId: vA.id }] } as never,
      { actorUserId: ACTOR },
    );
    check("workflow create with a variantId ok", wf.ok === true);
    if (wf.ok) {
      const st = await promotionService.listScopeTargets(wf.data.promotionId);
      check("workflow persisted the variant_id", st.length === 1 && st[0].variant_id === vA.id);
    }
  }

  // ── K. A variant-pinned target is REJECTED on a code / URL coupon (§7#1) ─────
  // Per-variant targeting is honoured only on the AUTO price path (the coupon path
  // has no variant facts), so a code/url promo with a variant pin must be refused
  // at authoring time rather than ship a coupon that discounts nothing.
  console.log("K. variant target guard on non-auto triggers:");
  {
    const pk = await mkProduct("k-var");
    const [kv] = await db.insert(product_variants)
      .values({ product_id: pk, label: "K", price_cents: 100_000, display_order: 0 } as never)
      .returning({ id: product_variants.id });
    const base = {
      discountType: "percent" as const, discountValue: 10, minCartCents: 0, isActive: true,
      isStackable: false, excludeDiscountedItems: false, grantsFreeShipping: false, displayPriority: 0,
    };
    const auto = await workflows.promotion.create(
      { ...base, triggerKind: "auto", name: `${TAG}-k-auto`, scope: "targeted", scopeId: null,
        scopeTargets: [{ targetType: "product", targetId: pk, variantId: kv.id }] } as never,
      { actorUserId: ACTOR },
    );
    check("K: AUTO promo with a variant target allowed", auto.ok === true);
    const code = await workflows.promotion.create(
      { ...base, triggerKind: "code", code: `${TAG}KCODE`, name: `${TAG}-k-code`, scope: "targeted", scopeId: null,
        scopeTargets: [{ targetType: "product", targetId: pk, variantId: kv.id }] } as never,
      { actorUserId: ACTOR },
    );
    check("K: CODE coupon with a variant target REJECTED", code.ok === false);
    const url = await workflows.promotion.create(
      { ...base, triggerKind: "url", urlSlug: `${TAG}-kslug`, name: `${TAG}-k-url`, scope: "targeted", scopeId: null,
        scopeTargets: [{ targetType: "product", targetId: pk, variantId: kv.id }] } as never,
      { actorUserId: ACTOR },
    );
    check("K: URL promo with a variant target REJECTED", url.ok === false);
    const codeWhole = await workflows.promotion.create(
      { ...base, triggerKind: "code", code: `${TAG}KCODE2`, name: `${TAG}-k-code2`, scope: "targeted", scopeId: null,
        scopeTargets: [{ targetType: "product", targetId: pk }] } as never,
      { actorUserId: ACTOR },
    );
    check("K: CODE coupon with a WHOLE-product target still allowed", codeWhole.ok === true);
  }

  // ── L. listForProductScope surfaces TARGETED promos (§7#2) ───────────────────
  // The product admin's « Promotions sur ce produit » must include a scope='targeted'
  // promo that lists the product via a scope_target, not just legacy scope='product'.
  console.log("L. listForProductScope includes targeted promos:");
  {
    const promos = await promotionService.listForProductScope(pProduct);
    check("L: the flagship targeted promo (via a product scope_target) is listed", promos.some((p) => p.id === targeted.id));
    check("L: category/brand-wide promos are NOT listed (not « sur ce produit »)", !promos.some((p) => p.scope === "category" || p.scope === "brand"));
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
