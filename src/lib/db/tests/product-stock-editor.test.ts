import "server-only";

/**
 * Product / variant editor stock integrity (A–Z 09-23, P1).
 *
 *   A. PURE — the shared sold-out rule (nextInStockForQty): restock from ≤0
 *      re-lists, a deliberately delisted line stays delisted, untrack re-lists a
 *      sold-out line, an untracked « Rupture » line re-lists on its first qty > 0;
 *      + the editors' dirty-gate (editedStockFields /
 *      variantStockFields): an untouched Stock tab sends NO stock keys, a blank
 *      quantity means untrack, a change carries expectedStockQty.
 *   B. updateProduct compare-and-set: a stale editor save (expectedStockQty =
 *      the page-load qty) after a SALE is refused with `conflict` — no write, no
 *      ledger row, no product.restocked; a save that omits the stock keys (the
 *      editor's untouched Stock tab) leaves the sold-out row alone.
 *   C. blank quantity = untrack (stockQty null) + a delta-0 ledger row.
 *   D. restock via the editor re-lists a sold-out product (+ restocked); a manual
 *      delist with units stays delisted.
 *   E. applyStockSet / applyStockDelta / setLocationLevel apply the same rule.
 *   F. variant editor: an untouched variant's stock is never re-written (sale
 *      survives a price-only save); a stale changed stock → conflict; a restock
 *      of a sold-out variant re-lists it.
 *   G. deleteProduct frees the variants' SKU/GTIN (re-usable) + zeroes them.
 *   H. duplicateProduct resets tracked stock (product + variants), keeps an
 *      untracked source untracked.
 *
 * Self-cleaning (rows tagged `zztest-pse…`). Run ONLY against a throwaway DB:
 *   DATABASE_URL=… pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/product-stock-editor.test.ts
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { editedStockFields, variantStockFields } from "@/lib/catalog/editor-stock-fields";
import { nextInStockForQty } from "@/lib/inventory/in-stock-rule";
import { applyStockDelta, applyStockSet } from "@/lib/inventory/adjust";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { productService } from "@/modules/catalog/product/service";
import { stock_movements } from "@/modules/stock-movement/schema";
import { stockLocationService } from "@/modules/stock-location/service";
import { workflows } from "@/workflows";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "zztest-pse";
const ACTOR = { actorUserId: `${TAG}-actor` };

const restocked: string[] = [];
bus.on("product.restocked", (e) => {
  restocked.push(e.payload.productId);
});

async function cleanup() {
  const mine = sql`(select id from products where slug like ${TAG + "%"})`;
  await db.execute(sql`delete from stock_movements where product_id in ${mine}`);
  await db.execute(sql`delete from stock_levels where product_id in ${mine}`);
  await db.execute(sql`delete from product_attribute_assignments where product_id in ${mine}`);
  await db.execute(sql`delete from product_variant_values where variant_id in (select id from product_variants where product_id in ${mine})`);
  await db.execute(sql`delete from product_variants where product_id in ${mine}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from stock_levels where location_id in (select id from stock_locations where name like ${TAG + "%"})`);
  await db.execute(sql`delete from stock_locations where name like ${TAG + "%"}`);
}

async function mkProduct(
  suffix: string,
  o: { stockQty: number | null; inStock: boolean; type?: "simple" | "variable"; published?: boolean },
): Promise<string> {
  const [row] = await db
    .insert(products)
    .values({
      slug: `${TAG}-${suffix}`,
      name: `${TAG} ${suffix}`,
      price_cents: 100_000,
      product_type: o.type ?? "simple",
      stock_qty: o.stockQty,
      in_stock: o.inStock,
      is_published: o.published ?? true,
      published_at: new Date(),
    } as never)
    .returning({ id: products.id });
  return row.id;
}

async function prod(id: string) {
  const [r] = await db.select().from(products).where(eq(products.id, id));
  return r;
}
async function variant(id: string) {
  const [r] = await db.select().from(product_variants).where(eq(product_variants.id, id));
  return r;
}
async function adminMoves(productId: string) {
  return db
    .select()
    .from(stock_movements)
    .where(and(eq(stock_movements.product_id, productId), eq(stock_movements.reason, "admin")));
}
/** A customer sale as place-order writes it (qty − n, in_stock from the result). */
async function sell(table: "products" | "variants", id: string, n: number) {
  if (table === "products") {
    await db.execute(sql`update products set stock_qty = stock_qty - ${n}, in_stock = (stock_qty - ${n}) > 0 where id = ${id}`);
  } else {
    await db.execute(sql`update product_variants set stock_qty = stock_qty - ${n}, in_stock = (stock_qty - ${n}) > 0 where id = ${id}`);
  }
}

async function main() {
  await cleanup();

  // ── A. pure rule ────────────────────────────────────────────────────────
  check("A: sold out (0,false) → restock 5 re-lists", nextInStockForQty(0, false, 5) === true);
  check("A: sold out (0,false) → still 0 stays off", nextInStockForQty(0, false, 0) === false);
  check("A: delisted (3,false) → 4 stays delisted", nextInStockForQty(3, false, 4) === false);
  check("A: in stock (3,true) → 0 de-lists", nextInStockForQty(3, true, 0) === false);
  check("A: in stock (3,true) → 7 stays listed", nextInStockForQty(3, true, 7) === true);
  check("A: untracked « Rupture » (null,false) → first qty 5 re-lists (restock)", nextInStockForQty(null, false, 5) === true);
  check("A: untracked « Rupture » (null,false) → first qty 0 stays off", nextInStockForQty(null, false, 0) === false);
  check("A: untracked listed (null,true) → first qty 0 de-lists", nextInStockForQty(null, true, 0) === false);
  check("A: untracked listed (null,true) → first qty 5 stays listed", nextInStockForQty(null, true, 5) === true);
  check("A: untracked « Rupture » stays untracked → flag kept", nextInStockForQty(null, false, null) === false);
  check("A: sold out → untrack (null) re-lists", nextInStockForQty(0, false, null) === true);
  check("A: delisted → untrack keeps the flag", nextInStockForQty(3, false, null) === false);

  // ── A2. pure — the editor dirty-gate (what the actions forward) ─────────
  const fd = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries(o)) f.set(k, v);
    return f;
  };
  const untouched = editedStockFields(fd({ stockQty: "1", inStock: "on", stockQtyOriginal: "1", inStockOriginal: "on" }));
  check("A2: untouched Stock tab → NO stock keys (no stale re-write)", Object.keys(untouched).length === 0);
  const qtyEdit = editedStockFields(fd({ stockQty: "4", inStock: "on", stockQtyOriginal: "1", inStockOriginal: "on" }));
  check(
    "A2: qty edit → stockQty + expectedStockQty, availability left to the rule",
    qtyEdit.stockQty === 4 && qtyEdit.expectedStockQty === 1 && !("inStock" in qtyEdit),
  );
  const blank = editedStockFields(fd({ stockQty: "", inStock: "on", stockQtyOriginal: "5", inStockOriginal: "on" }));
  check("A2: blank qty → null (untrack), not ignored", "stockQty" in blank && blank.stockQty === null && blank.expectedStockQty === 5);
  const flagOnly = editedStockFields(fd({ stockQty: "", stockQtyOriginal: "", inStockOriginal: "on" })); // box unticked
  check("A2: availability-only edit → inStock:false, no qty key", flagOnly.inStock === false && !("stockQty" in flagOnly));
  const legacy = editedStockFields(fd({ stockQty: "2", inStock: "on" }));
  check("A2: no originals → absolute keys (legacy)", legacy.stockQty === 2 && legacy.inStock === true && !("expectedStockQty" in legacy));
  check(
    "A2: unchanged existing variant → no stock keys",
    Object.keys(variantStockFields({ id: "x", stockQty: 2, inStock: true, origStockQty: 2, origInStock: true })).length === 0,
  );
  const vEdit = variantStockFields({ id: "x", stockQty: 5, inStock: true, origStockQty: 2, origInStock: true });
  check("A2: changed variant stock → stockQty + expectedStockQty", vEdit.stockQty === 5 && vEdit.expectedStockQty === 2 && !("inStock" in vEdit));
  const vNew = variantStockFields({ id: null, stockQty: "", inStock: true });
  check("A2: new variant → absolute (blank = untracked)", vNew.stockQty === null && vNew.inStock === true);

  // ── B. stale editor save after a sale ───────────────────────────────────
  const b = await mkProduct("b", { stockQty: 1, inStock: true });
  await sell("products", b, 1); // the unique watch is sold while the editor is open
  restocked.length = 0;
  // (1) SEO-only save: the action omits the unchanged stock keys.
  const rB1 = await workflows.catalog.updateProduct({ productId: b, metaTitle: `${TAG} seo` }, ACTOR);
  const afterB1 = await prod(b);
  check("B1: unrelated save ok", rB1.ok === true);
  check("B1: sold unit NOT resurrected (qty 0, in_stock false)", afterB1.stock_qty === 0 && afterB1.in_stock === false);
  check("B1: no phantom admin ledger row", (await adminMoves(b)).length === 0);
  check("B1: no false product.restocked", !restocked.includes(b));
  // (2) the operator DID edit the stock, from a stale page (loaded at qty 1).
  const rB2 = await workflows.catalog.updateProduct(
    { productId: b, stockQty: 3, expectedStockQty: 1 },
    ACTOR,
  );
  const afterB2 = await prod(b);
  check("B2: stale stock edit refused with conflict", rB2.ok === false && !rB2.ok && rB2.error === "conflict");
  check("B2: conflict carries a stockQty field error (Stock tab focus)", !rB2.ok && !!rB2.fieldErrors?.stockQty);
  check("B2: nothing written", afterB2.stock_qty === 0 && afterB2.in_stock === false);
  check("B2: no ledger row, no restocked", (await adminMoves(b)).length === 0 && !restocked.includes(b));
  // API callers (no expectedStockQty) keep the absolute-set semantics.
  const rB3 = await workflows.catalog.updateProduct({ productId: b, stockQty: 2 }, ACTOR);
  const afterB3 = await prod(b);
  check("B3: API absolute set still applies", rB3.ok === true && afterB3.stock_qty === 2);
  check("B3: quantity-only restock of a sold-out product re-lists it", afterB3.in_stock === true);
  check("B3: restock fires product.restocked", restocked.includes(b));
  const movesB3 = await adminMoves(b);
  check("B3: ledger delta from the LOCKED value (+2)", movesB3.length === 1 && movesB3[0].delta === 2);

  // ── C. blank quantity = untrack ─────────────────────────────────────────
  const c = await mkProduct("c", { stockQty: 5, inStock: true });
  const rC = await workflows.catalog.updateProduct({ productId: c, stockQty: null, expectedStockQty: 5 }, ACTOR);
  const afterC = await prod(c);
  check("C: untrack ok", rC.ok === true);
  check("C: stock_qty cleared to NULL (untracked)", afterC.stock_qty === null && afterC.in_stock === true);
  const movesC = await adminMoves(c);
  check("C: tracked→untracked ledgered with delta 0", movesC.length === 1 && movesC[0].delta === 0 && movesC[0].resulting_qty === null);

  // ── D. editor restock / manual delist ───────────────────────────────────
  const d = await mkProduct("d", { stockQty: 0, inStock: false });
  restocked.length = 0;
  const rD = await workflows.catalog.updateProduct({ productId: d, stockQty: 4, expectedStockQty: 0 }, ACTOR);
  const afterD = await prod(d);
  check("D1: restock from the editor (flag untouched) re-lists", rD.ok === true && afterD.stock_qty === 4 && afterD.in_stock === true);
  check("D1: restocked emitted", restocked.includes(d));
  const d2 = await mkProduct("d2", { stockQty: 3, inStock: false });
  await workflows.catalog.updateProduct({ productId: d2, stockQty: 5, expectedStockQty: 3 }, ACTOR);
  const afterD2 = await prod(d2);
  check("D2: a deliberately delisted product stays delisted on a qty edit", afterD2.stock_qty === 5 && afterD2.in_stock === false);
  await workflows.catalog.updateProduct({ productId: d2, inStock: true, expectedStockQty: 5 }, ACTOR);
  check("D3: an explicit availability change still applies", (await prod(d2)).in_stock === true);

  // ── E. the other writers share the rule ─────────────────────────────────
  const e1 = await mkProduct("e1", { stockQty: 0, inStock: false });
  const sE1 = await applyStockSet({ kind: "product", rowId: e1, productId: e1 }, { setQty: 6 }, { reason: "api_set" });
  check("E1: applyStockSet qty-only restock re-lists + reports becameAvailable", sE1.inStock === true && sE1.becameAvailable && (await prod(e1)).in_stock === true);
  const e2 = await mkProduct("e2", { stockQty: 3, inStock: false });
  const sE2 = await applyStockSet({ kind: "product", rowId: e2, productId: e2 }, { setQty: 4 }, { reason: "api_set" });
  check("E2: applyStockSet keeps a manual delist", sE2.inStock === false && !sE2.becameAvailable && (await prod(e2)).in_stock === false);
  const dE2 = await applyStockDelta({ kind: "product", rowId: e2, productId: e2 }, 1, { reason: "api_delta" });
  check("E3: applyStockDelta +1 keeps a manual delist", dE2.ok && dE2.inStock === false && (await prod(e2)).in_stock === false);
  const e4 = await mkProduct("e4", { stockQty: 0, inStock: false });
  const dE4 = await applyStockDelta({ kind: "product", rowId: e4, productId: e4 }, 2, { reason: "api_delta" });
  check("E4: applyStockDelta restock of a sold-out line re-lists", dE4.ok && dE4.inStock === true && dE4.becameAvailable);
  const dE5 = await applyStockDelta({ kind: "product", rowId: e4, productId: e4 }, -2, { reason: "api_delta" });
  check("E5: applyStockDelta to 0 de-lists", dE5.ok && dE5.inStock === false && (await prod(e4)).in_stock === false);

  // An UNTRACKED line marked « Rupture » (the only way to say sold out without a
  // quantity) is re-listed when an ERP quantity-only sync starts tracking it.
  const e8 = await mkProduct("e8", { stockQty: null, inStock: false });
  restocked.length = 0;
  const sE8 = await applyStockSet({ kind: "product", rowId: e8, productId: e8 }, { setQty: 10 }, { reason: "api_set" });
  const afterE8 = await prod(e8);
  check(
    "E8: applyStockSet first qty on an untracked « Rupture » line re-lists + becameAvailable",
    sE8.inStock === true && sE8.becameAvailable && afterE8.stock_qty === 10 && afterE8.in_stock === true,
  );
  const e9 = await mkProduct("e9", { stockQty: null, inStock: false });
  const sE9 = await applyStockSet({ kind: "product", rowId: e9, productId: e9 }, { setQty: 0 }, { reason: "api_set" });
  check("E9: …a first qty of 0 keeps it off", sE9.inStock === false && !sE9.becameAvailable);

  const loc = await stockLocationService.create({ name: `${TAG}-loc`, is_default: false, is_active: true } as never);
  const e6 = await mkProduct("e6", { stockQty: 2, inStock: false });
  await stockLocationService.setLocationLevel({ productId: e6, variantId: null }, loc.id, 3);
  const afterE6 = await prod(e6);
  check("E6: per-location level edit keeps a manual delist", afterE6.stock_qty === 5 && afterE6.in_stock === false);
  const e7 = await mkProduct("e7", { stockQty: 0, inStock: false });
  const lE7 = await stockLocationService.setLocationLevel({ productId: e7, variantId: null }, loc.id, 2);
  check("E7: per-location restock of a sold-out line re-lists", (await prod(e7)).in_stock === true && lE7.becameAvailable);

  // ── F. variant editor ───────────────────────────────────────────────────
  const f = await mkProduct("f", { stockQty: null, inStock: true, type: "variable" });
  await productService.replaceVariants(f, [
    { label: "A", sku: `${TAG}-fa`, gtin: null, mpn: null, priceCents: 50_000, oldPriceCents: null, stockQty: 2, inStock: true, imageMediaId: null, displayOrder: 0, isDefault: true, attributeValueIds: [] },
    { label: "B", sku: `${TAG}-fb`, gtin: null, mpn: null, priceCents: 50_000, oldPriceCents: null, stockQty: 0, inStock: false, imageMediaId: null, displayOrder: 1, isDefault: false, attributeValueIds: [] },
  ]);
  const liveF = await db
    .select({ id: product_variants.id, label: product_variants.label })
    .from(product_variants)
    .where(and(eq(product_variants.product_id, f), isNull(product_variants.deleted_at)));
  const vA = liveF.find((v) => v.label === "A")!;
  const vB = liveF.find((v) => v.label === "B")!;
  await sell("variants", vA.id, 1); // 2 → 1 while the editor is open
  // Price-only save: A's stock unchanged vs its page-load baseline → omitted.
  const rF1 = await workflows.catalog.upsertProductVariants(
    {
      productId: f,
      variants: [
        { id: vA.id, label: "A", sku: `${TAG}-fa`, priceCents: 45_000, isDefault: true, displayOrder: 0 },
        { id: vB.id, label: "B", sku: `${TAG}-fb`, priceCents: 50_000, displayOrder: 1 },
      ],
    },
    ACTOR,
  );
  check("F1: price-only variant save ok", rF1.ok === true);
  check("F1: the sale survives (A qty 1, not the page-load 2)", (await variant(vA.id)).stock_qty === 1);
  check("F1: no phantom variant ledger row", (await adminMoves(f)).length === 0);
  // A stale CHANGED stock on A (page loaded at 2, DB now 1) → conflict.
  const rF2 = await workflows.catalog.upsertProductVariants(
    {
      productId: f,
      variants: [
        { id: vA.id, label: "A", sku: `${TAG}-fa`, priceCents: 45_000, stockQty: 5, expectedStockQty: 2, isDefault: true, displayOrder: 0 },
        { id: vB.id, label: "B", sku: `${TAG}-fb`, priceCents: 50_000, displayOrder: 1 },
      ],
    },
    ACTOR,
  );
  check("F2: stale variant stock edit refused with conflict", rF2.ok === false && !rF2.ok && rF2.error === "conflict");
  check("F2: nothing written", (await variant(vA.id)).stock_qty === 1 && (await variant(vA.id)).price_cents === 45_000);
  // Restock the sold-out variant B (baseline 0) → re-listed + restocked.
  restocked.length = 0;
  const rF3 = await workflows.catalog.upsertProductVariants(
    {
      productId: f,
      variants: [
        { id: vA.id, label: "A", sku: `${TAG}-fa`, priceCents: 45_000, isDefault: true, displayOrder: 0 },
        { id: vB.id, label: "B", sku: `${TAG}-fb`, priceCents: 50_000, stockQty: 3, expectedStockQty: 0, displayOrder: 1 },
      ],
    },
    ACTOR,
  );
  const afterVB = await variant(vB.id);
  check("F3: sold-out variant restock re-lists it", rF3.ok === true && afterVB.stock_qty === 3 && afterVB.in_stock === true);
  check("F3: variant restock fires product.restocked (per-variant mode)", restocked.includes(f));
  const movesF = await adminMoves(f);
  check("F3: variant restock ledgered +3", movesF.length === 1 && movesF[0].delta === 3 && movesF[0].variant_id === vB.id);
  // A stale editor still holding a variant deleted elsewhere (stock omitted as
  // "unchanged") must not re-insert it as untracked / unlimited.
  const rF4 = await workflows.catalog.upsertProductVariants(
    {
      productId: f,
      variants: [
        { id: vA.id, label: "A", sku: `${TAG}-fa`, priceCents: 45_000, isDefault: true, displayOrder: 0 },
        { id: randomUUID(), label: "Gone", priceCents: 50_000, displayOrder: 1 },
      ],
    },
    ACTOR,
  );
  check("F4: a no-longer-live variant id with omitted stock → conflict (no unlimited re-insert)", rF4.ok === false && !rF4.ok && rF4.error === "conflict");
  check("F4: nothing written (B still live)", (await variant(vB.id)).deleted_at === null);

  // ── G. delete frees variant codes ───────────────────────────────────────
  const g = await mkProduct("g", { stockQty: null, inStock: true, type: "variable" });
  const gtin = `9${String(Date.now()).slice(-12)}`;
  await productService.replaceVariants(g, [
    { label: "G", sku: `${TAG}-gsku`, gtin, mpn: null, priceCents: 50_000, oldPriceCents: null, stockQty: 4, inStock: true, imageMediaId: null, displayOrder: 0, isDefault: true, attributeValueIds: [] },
  ]);
  const [gv] = await productService.listVariantStock(g);
  const rG = await workflows.catalog.deleteProduct({ productId: g }, ACTOR);
  const gvAfter = await variant(gv.id);
  check("G1: delete ok", rG.ok === true);
  check("G1: variant soft-deleted with its sku/gtin freed + stock zeroed", gvAfter.deleted_at !== null && gvAfter.sku === null && gvAfter.gtin === null && gvAfter.stock_qty === 0);
  const g2 = await mkProduct("g2", { stockQty: null, inStock: true, type: "variable" });
  const rG2 = await workflows.catalog.upsertProductVariants(
    { productId: g2, variants: [{ label: "G", sku: `${TAG}-gsku`, gtin, priceCents: 50_000, isDefault: true }] },
    ACTOR,
  );
  check("G2: the deleted product's variant SKU/GTIN can be reused", rG2.ok === true);

  // ── H. duplicate resets tracked stock ───────────────────────────────────
  const h = await mkProduct("h", { stockQty: 4, inStock: true, type: "variable" });
  await productService.replaceVariants(h, [
    { label: "H", sku: null, gtin: null, mpn: null, priceCents: 50_000, oldPriceCents: null, stockQty: 2, inStock: true, imageMediaId: null, displayOrder: 0, isDefault: true, attributeValueIds: [] },
  ]);
  const rH = await workflows.catalog.duplicateProduct({ productId: h }, ACTOR);
  check("H1: duplicate ok + reports the stock reset", rH.ok === true && rH.ok && rH.data.stockReset === true);
  if (rH.ok) {
    const copy = await prod(rH.data.productId);
    check("H1: tracked copy starts at 0 / out of stock", copy.stock_qty === 0 && copy.in_stock === false);
    const [cv] = await productService.listVariantStock(rH.data.productId);
    check("H1: copied variant starts at 0 / out of stock", cv?.stock_qty === 0 && cv?.in_stock === false);
  }
  const h2 = await mkProduct("h2", { stockQty: null, inStock: true });
  const rH2 = await workflows.catalog.duplicateProduct({ productId: h2 }, ACTOR);
  if (rH2.ok) {
    const copy2 = await prod(rH2.data.productId);
    check("H2: untracked source → untracked, in-stock copy (no reset reported)", copy2.stock_qty === null && copy2.in_stock === true && rH2.data.stockReset === false);
  } else {
    check("H2: duplicate ok", false);
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
