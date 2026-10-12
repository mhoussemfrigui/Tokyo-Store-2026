import "server-only";

/**
 * Catalog admin correctness (A–Z 09-23, phase 4 — p4-catalog-admin).
 *
 *   A. GTIN: the product-level gtin gets the variant rule (8–14 digits) on
 *      create + on a NEW/CHANGED update value; a legacy non-conforming code
 *      re-sent unchanged stays saveable.
 *   B. A 'variable' product can't be PUBLISHED without a live variant (create +
 *      update: promotion, publish of a draft); drafts are allowed; once a variant
 *      exists it publishes. The storefront mapper never advertises a variant-less
 *      variable product as in stock.
 *   C. add-to-cart refuses a variant-less line on a variable product
 *      (`needs_options`) and accepts it with a variant.
 *   E. product.updated changedFields lists only what ACTUALLY changed: a
 *      full-form no-op re-save emits nothing; a rename reports ["name"]; a
 *      stock-only save doesn't touch the embedding gate.
 *   F. « Retirer la marque »: brandId null REMOVES the link (+ "brand" in
 *      changedFields, which re-embeds); an absent brandId leaves it.
 *   G. External API by-ref read returns the SAME effective (live auto promo)
 *      price as the card/list path, with the stored price as basePriceCents.
 *
 * Self-cleaning (rows tagged `zztest-cadm…`). Run ONLY against a throwaway DB:
 *   DATABASE_URL=… pnpm exec tsx --conditions=react-server \
 *     src/lib/db/tests/catalog-admin.test.ts
 */
import { randomInt, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { changedFieldsAffectEmbedding } from "@/events/subscribers/reembed-fields";
import { enrichProductSearchHits, getApiProductByRef } from "@/lib/api/products";
import { productBrandLink } from "@/associations/catalog.service";
import { brands } from "@/modules/catalog/brand/schema";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { cartService } from "@/modules/cart/service";
import { promotionService } from "@/modules/promotion";
import type { NewPromotionRow } from "@/modules/promotion/schema";
import { workflows } from "@/workflows";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "zztest-cadm";
const ACTOR = { actorUserId: `${TAG}-actor` };

/** product.updated envelopes, keyed by product id. */
const updates = new Map<string, string[][]>();
bus.on("product.updated", (e) => {
  const list = updates.get(e.payload.productId) ?? [];
  list.push(e.payload.changedFields);
  updates.set(e.payload.productId, list);
});
const eventsFor = (id: string) => updates.get(id) ?? [];

async function cleanup() {
  const mine = sql`(select id from products where slug like ${TAG + "%"})`;
  await db.execute(sql`delete from cart_items where cart_id in (select id from carts where token like ${TAG + "%"})`);
  await db.execute(sql`delete from carts where token like ${TAG + "%"}`);
  await db.execute(sql`delete from promotion_redemptions where promotion_id in (select id from promotions where name like ${TAG + "%"})`);
  await db.execute(sql`delete from promotions where name like ${TAG + "%"}`);
  await db.execute(sql`delete from stock_movements where product_id in ${mine}`);
  await db.execute(sql`delete from product_brands where product_id in ${mine}`);
  await db.execute(sql`delete from product_variants where product_id in ${mine}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from brands where slug like ${TAG + "%"}`);
}

async function prod(id: string) {
  const [r] = await db.select().from(products).where(eq(products.id, id));
  return r;
}

/** A valid, collision-unlikely 13-digit GTIN. */
const gtin13 = () => `2${randomInt(100_000_000_000, 999_999_999_999)}`;

/** createProduct with the test defaults (a DRAFT unless `publish`). */
async function create(suffix: string, extra: Record<string, unknown> = {}) {
  return workflows.catalog.createProduct(
    {
      name: `${TAG} ${suffix}`,
      slug: `${TAG}-${suffix}`,
      priceCents: 100_000,
      ...extra,
    },
    ACTOR,
  );
}

async function createOk(suffix: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await create(suffix, extra);
  if (!r.ok) throw new Error(`fixture ${suffix} failed: ${r.message}`);
  return r.data.productId;
}

async function main() {
  await cleanup();

  // ── A. GTIN format ────────────────────────────────────────────────────────
  const rA1 = await create("a1", { gtin: "EAN-1234" });
  check("A1: create with a non-digit GTIN is refused", !rA1.ok && !!rA1.fieldErrors?.gtin);
  const rA2 = await create("a2", { gtin: "1234567" });
  check("A2: create with a 7-digit GTIN is refused", !rA2.ok && !!rA2.fieldErrors?.gtin);
  const okGtin = gtin13();
  const a3 = await createOk("a3", { gtin: okGtin });
  check("A3: a 13-digit GTIN is stored as-is", (await prod(a3)).gtin === okGtin);
  // ≤ 14 chars (the column's schema cap has always applied), but not digits-only.
  const legacyGtin = `LG-${randomInt(100_000, 999_999)}`;
  const [legacy] = await db
    .insert(products)
    .values({ slug: `${TAG}-a4`, name: `${TAG} a4`, price_cents: 100_000, gtin: legacyGtin } as never)
    .returning({ id: products.id });
  const rA4 = await workflows.catalog.updateProduct(
    { productId: legacy.id, gtin: legacyGtin, name: `${TAG} a4 renamed` },
    ACTOR,
  );
  check("A4: a legacy non-conforming GTIN re-sent UNCHANGED stays saveable", rA4.ok);
  const rA5 = await workflows.catalog.updateProduct({ productId: legacy.id, gtin: "N/A" }, ACTOR);
  check("A5: changing it to another invalid GTIN is refused", !rA5.ok && !!rA5.fieldErrors?.gtin);
  const rA6 = await workflows.catalog.updateProduct({ productId: legacy.id, gtin: gtin13() }, ACTOR);
  check("A6: changing it to a valid GTIN is accepted", rA6.ok);

  // ── B. variable product publish guard ─────────────────────────────────────
  const rB1 = await create("b1", { productType: "variable", publish: true });
  check("B1: create 'variable' + publish is refused (no variants yet)", !rB1.ok && !!rB1.fieldErrors?.productType);
  const b2 = await createOk("b2", { productType: "variable", publish: false });
  check("B2: create 'variable' as a DRAFT is allowed", (await prod(b2)).product_type === "variable");
  const apiB2 = await getApiProductByRef({ productId: b2 }, { includeUnpublished: true });
  check("B2: the mapper never advertises a variant-less variable product as in stock", apiB2?.inStock === false);
  const rB3 = await workflows.catalog.updateProduct({ productId: b2, publish: true }, ACTOR);
  check("B3: publishing the variant-less variable draft is refused", !rB3.ok && !!rB3.fieldErrors?.productType);
  check("B3: …and it stays a draft", (await prod(b2)).is_published === false);
  const [v] = await db
    .insert(product_variants)
    .values({ product_id: b2, label: `${TAG} v`, price_cents: 90_000, stock_qty: 5, in_stock: true } as never)
    .returning({ id: product_variants.id });
  const rB4 = await workflows.catalog.updateProduct({ productId: b2, publish: true }, ACTOR);
  check("B4: once a live variant exists it publishes", rB4.ok && (await prod(b2)).is_published === true);

  const b5 = await createOk("b5", { publish: true });
  const rB5 = await workflows.catalog.updateProduct({ productId: b5, productType: "variable" }, ACTOR);
  check("B5: promoting a PUBLISHED simple product to 'variable' without variants is refused", !rB5.ok && !!rB5.fieldErrors?.productType);
  check("B5: …and it stays simple", (await prod(b5)).product_type === "simple");
  const b6 = await createOk("b6");
  const rB6 = await workflows.catalog.updateProduct({ productId: b6, productType: "variable", publish: false }, ACTOR);
  check("B6: promoting a DRAFT to 'variable' is allowed", rB6.ok && (await prod(b6)).product_type === "variable");

  // ── C. add-to-cart on a variable product ──────────────────────────────────
  const cart = await cartService.createCart({ token: `${TAG}-cart-${randomUUID()}` });
  const rC1 = await workflows.cart.add({ cartId: cart.id, productId: b2, quantity: 1 });
  check("C1: a variant-less line on a variable product is refused (needs_options)", !rC1.ok && rC1.error === "needs_options");
  const rC2 = await workflows.cart.add({ cartId: cart.id, productId: b2, variantId: v.id, quantity: 1 });
  check("C2: the same product WITH a variant is added", rC2.ok);

  // ── E + F. changedFields + brand removal ──────────────────────────────────
  const [brand] = await db
    .insert(brands)
    .values({ slug: `${TAG}-brand`, name: `${TAG} Brand` } as never)
    .returning({ id: brands.id });
  const e1 = await createOk("e1", { shortDesc: "court", brandId: brand.id });
  // The admin editor's shape: EVERY key re-sent, nothing actually changed.
  const fullForm = {
    productId: e1,
    name: `${TAG} e1`,
    slug: `${TAG}-e1`,
    platform: null,
    sku: null,
    gtin: null,
    mpn: null,
    condition: "new" as const,
    externalRef: null,
    warrantyMonths: null,
    warrantyLabel: null,
    taxRateBps: null,
    productType: "simple" as const,
    sharedVariantStock: null,
    shortDesc: "court",
    description: "",
    priceCents: 100_000,
    oldPriceCents: null,
    minPurchaseQty: null,
    maxPurchaseQty: null,
    videoUrl: null,
    videoPosterMediaId: null,
    videoTitle: null,
    videoDescription: null,
    metaTitle: null,
    metaDescription: null,
    canonicalUrl: null,
    noindex: false,
    ogImageMediaId: null,
    publish: false,
    isDiscountable: true,
    categoryIds: [],
    brandId: brand.id,
    mediaIds: [],
    attributeValueIds: [],
    attributeScalars: [],
    relatedMode: "auto" as const,
    relatedProductIds: [],
    complementaryProductIds: [],
  };
  const rE1 = await workflows.catalog.updateProduct(fullForm, ACTOR);
  check("E1: a full-form NO-OP re-save succeeds", rE1.ok);
  check("E1: …and emits no product.updated at all", eventsFor(e1).length === 0);
  await workflows.catalog.updateProduct({ ...fullForm, name: `${TAG} e1 renamed` }, ACTOR);
  const e2Events = eventsFor(e1);
  check(
    "E2: a rename re-sending every key reports ONLY ['name']",
    e2Events.length === 1 && JSON.stringify(e2Events[0]) === JSON.stringify(["name"]),
  );
  await workflows.catalog.updateProduct({ productId: e1, stockQty: 3 }, ACTOR);
  const stockEvent = eventsFor(e1).at(-1) ?? [];
  check("E3: a stock-only save reports the stock column", stockEvent.includes("stock_qty"));
  check("E3: …which does not trip the re-embed gate", changedFieldsAffectEmbedding(stockEvent) === false);

  const nBefore = eventsFor(e1).length;
  await workflows.catalog.updateProduct({ productId: e1, name: `${TAG} e1 again` }, ACTOR);
  check("F1: a save WITHOUT brandId leaves the brand", (await productBrandLink.findBrandId(e1)) === brand.id);
  const rF2 = await workflows.catalog.updateProduct({ ...fullForm, name: `${TAG} e1 again`, brandId: null }, ACTOR);
  check("F2: brandId null (« Retirer la marque ») succeeds", rF2.ok);
  check("F2: …and REMOVES the brand link", (await productBrandLink.findBrandId(e1)) === null);
  const f2Fields = eventsFor(e1).at(-1) ?? [];
  check(
    "F2: …reported as ['brand'] (re-embeds)",
    eventsFor(e1).length === nBefore + 2 &&
      JSON.stringify(f2Fields) === JSON.stringify(["brand"]) &&
      changedFieldsAffectEmbedding(f2Fields),
  );
  const rF3 = await workflows.catalog.updateProduct({ productId: e1, brandId: null }, ACTOR);
  check("F3: clearing an already-empty brand is a no-op (no event)", rF3.ok && eventsFor(e1).length === nBefore + 2);

  // ── G. API by-ref price parity with the card/list path ────────────────────
  const g0 = await createOk("g0", { publish: true });
  const g1 = await createOk("g1", { publish: true, isDiscountable: true });
  await promotionService.insert({
    name: `${TAG}-auto`, trigger_kind: "auto", scope: "product", scope_id: g1,
    discount_type: "percent", discount_value: 20, is_stackable: true, is_active: true,
  } as NewPromotionRow);
  const plain = await getApiProductByRef({ productId: g0 }, { includeUnpublished: true });
  check(
    "G0: no promo → effective price == stored price",
    plain?.priceCents === 100_000 && plain.basePriceCents === 100_000 && plain.baseOldPriceCents === null,
  );
  const promoted = await getApiProductByRef({ productId: g1 }, { includeUnpublished: true });
  const hits = [{ id: g1, price_cents: 100_000, old_price_cents: null as number | null }];
  await enrichProductSearchHits(hits);
  check("G1: by-ref read applies the live auto promo (80 000)", promoted?.priceCents === 80_000);
  check("G1: …same effective price as the card/list path", promoted?.priceCents === hits[0].price_cents);
  check("G1: …the promo struck-through reference is the stored price", promoted?.oldPriceCents === 100_000);
  check(
    "G1: …and the STORED price stays readable (basePriceCents) for create-then-verify",
    promoted?.basePriceCents === 100_000 && promoted.baseOldPriceCents === null,
  );

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
