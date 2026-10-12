import "server-only";

/**
 * Stock-ledger completeness + location-delete cache fan-out (A–Z 09-23, P5).
 *
 * `stock_movements` promises ONE row per stock change. The variant editor
 * (upsertProductVariantsWorkflow) left three changes unledgered:
 *   - a REMOVED tracked variant (soft-deleted at stock 0 by replaceVariants) —
 *     now an `admin` row −old → 0, note « variante supprimée »;
 *   - a kept variant switching tracking (number→null / null→number) — now a
 *     delta-0 marker whose resulting_qty re-baselines the line, the same shape
 *     applyStockSet (ERP api_set) writes, notes « suivi désactivé / activé »;
 *   - the demotion reset of a NULL parent to a tracked 0 — a delta-0 marker,
 *     note « rétrogradation ».
 * evacuateLocation (location delete) now reports the products whose cached
 * total / in_stock NET-changed (→ product.updated) and the ones made sellable
 * again (→ product.restocked): a write-off from an active location and a
 * transfer out of an INACTIVE one move totals; an active-source transfer nets
 * to zero; an inactive-source write-off moves nothing. A line failing part-way
 * throws an EvacuatePartialError carrying what the committed lines changed.
 *
 * Self-cleaning (`__ilc…`). Run against the ISOLATED test DB only:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/inventory-ledger-completeness.test.ts
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { productService, type VariantInput } from "@/modules/catalog/product/service";
import { stock_levels } from "@/modules/stock-location/schema";
import { EvacuatePartialError, stockLocationService } from "@/modules/stock-location/service";
import { stock_movements } from "@/modules/stock-movement/schema";
import { upsertProductVariantsWorkflow } from "@/workflows/catalog/upsert-product-variants";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__ilc";
const ACTOR = { actorUserId: `${TAG}-actor` };

async function cleanup() {
  const mine = sql`(select id from products where slug like ${TAG + "%"})`;
  await db.execute(sql`delete from stock_movements where product_id in ${mine}`);
  await db.execute(sql`delete from stock_levels where product_id in ${mine}`);
  await db.execute(sql`delete from stock_locations where name like ${TAG + "%"}`);
  await db.execute(sql`delete from product_variant_values where variant_id in (select id from product_variants where product_id in ${mine})`);
  await db.execute(sql`delete from product_variants where product_id in ${mine}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

async function mkProduct(slug: string, o: { stockQty: number | null; type?: "simple" | "variable" }) {
  const [p] = await db
    .insert(products)
    .values({
      slug: `${TAG}-${slug}`,
      name: `${TAG} ${slug}`,
      price_cents: 10_000,
      product_type: o.type ?? "simple",
      stock_qty: o.stockQty,
      in_stock: true,
      is_published: true,
    } as never)
    .returning({ id: products.id });
  return p.id;
}

function mkV(o: Partial<VariantInput> & { label: string }): VariantInput {
  return {
    id: null, sku: `${TAG}-${o.label}`, gtin: null, mpn: null, priceCents: 10_000, oldPriceCents: null,
    stockQty: null, inStock: true, imageMediaId: null, displayOrder: 0, isDefault: false,
    attributeValueIds: [], ...o,
  };
}

async function adminRows(productId: string) {
  return db
    .select({
      variantId: stock_movements.variant_id,
      delta: stock_movements.delta,
      resultingQty: stock_movements.resulting_qty,
      note: stock_movements.note,
      actor: stock_movements.actor_user_id,
    })
    .from(stock_movements)
    .where(and(eq(stock_movements.product_id, productId), eq(stock_movements.reason, "admin")));
}

async function main() {
  await cleanup();

  // ── V. variant editor: removal, tracking switches, demotion reset ─────────
  {
    const p = await mkProduct("v", { stockQty: null, type: "variable" });
    await productService.replaceVariants(p, [
      mkV({ label: "A", stockQty: 5, displayOrder: 0, isDefault: true }),
      mkV({ label: "B", stockQty: 3, displayOrder: 1 }),
      mkV({ label: "C", stockQty: null, displayOrder: 2 }),
      mkV({ label: "D", stockQty: 0, inStock: false, displayOrder: 3 }),
      mkV({ label: "E", stockQty: 7, displayOrder: 4 }),
    ]);
    const liveRows = await db
      .select({ id: product_variants.id, label: product_variants.label })
      .from(product_variants)
      .where(and(eq(product_variants.product_id, p), isNull(product_variants.deleted_at)));
    const id = (l: string) => liveRows.find((r) => r.label === l)!.id;

    // Save 1: A tracked → untracked, B untouched, C untracked → tracked 4,
    // D (0 units) + E (7 units) removed.
    const r1 = await upsertProductVariantsWorkflow(
      {
        productId: p,
        variants: [
          { id: id("A"), label: "A", sku: `${TAG}-A`, priceCents: 10_000, stockQty: null, isDefault: true, displayOrder: 0 },
          { id: id("B"), label: "B", sku: `${TAG}-B`, priceCents: 10_000, displayOrder: 1 },
          { id: id("C"), label: "C", sku: `${TAG}-C`, priceCents: 10_000, stockQty: 4, displayOrder: 2 },
        ],
      },
      ACTOR,
    );
    check("V1: variant save ok", r1.ok === true);
    const rows1 = await adminRows(p);
    const of = (rows: typeof rows1, l: string) => rows.filter((r) => r.variantId === id(l));
    const e = of(rows1, "E");
    check(
      "V1: removed tracked variant E ledgered −7 → 0 « variante supprimée »",
      e.length === 1 && e[0].delta === -7 && e[0].resultingQty === 0 && e[0].note === "variante supprimée",
    );
    check("V1: removal row carries the actor", e[0]?.actor === ACTOR.actorUserId);
    check("V1: removed EMPTY variant D writes no row (no quantity moved)", of(rows1, "D").length === 0);
    const a = of(rows1, "A");
    check(
      "V1: tracked → untracked A = delta-0 marker, resulting null « suivi désactivé »",
      a.length === 1 && a[0].delta === 0 && a[0].resultingQty === null && a[0].note === "suivi désactivé",
    );
    const c = of(rows1, "C");
    check(
      "V1: untracked → tracked C = delta-0 marker, resulting 4 « suivi activé »",
      c.length === 1 && c[0].delta === 0 && c[0].resultingQty === 4 && c[0].note === "suivi activé",
    );
    check("V1: untouched B writes no row", of(rows1, "B").length === 0);
    check("V1: exactly 3 admin rows", rows1.length === 3);

    // Save 2: empty the set → demote to simple; NULL parent reset to tracked 0.
    const r2 = await upsertProductVariantsWorkflow({ productId: p, variants: [] }, ACTOR);
    check("V2: emptying save ok", r2.ok === true);
    const [prow] = await db.select().from(products).where(eq(products.id, p));
    check("V2: demoted to simple with parent reset 0 / out of stock", prow.product_type === "simple" && prow.stock_qty === 0 && prow.in_stock === false);
    const rows2 = await adminRows(p);
    const parent = rows2.filter((r) => r.variantId === null);
    check(
      "V2: demotion reset ledgered as a delta-0 marker, resulting 0 « rétrogradation »",
      parent.length === 1 && parent[0].delta === 0 && parent[0].resultingQty === 0 && parent[0].note === "rétrogradation",
    );
    const b = of(rows2, "B");
    check("V2: removed B ledgered −3 → 0", b.length === 1 && b[0].delta === -3 && b[0].resultingQty === 0);
    const c2 = of(rows2, "C").filter((r) => r.note === "variante supprimée");
    check("V2: removed C (now tracked 4) ledgered −4 → 0", c2.length === 1 && c2[0].delta === -4);
    check("V2: removed A (untracked) writes no removal row", of(rows2, "A").filter((r) => r.note === "variante supprimée").length === 0);
  }

  // ── L. evacuateLocation reports the NET-touched / restocked products ──────
  {
    // L1: write-off from an ACTIVE location drops the total → touched.
    const p1 = await mkProduct("l1", { stockQty: 0 });
    const src1 = await stockLocationService.create({ name: `${TAG}-l1src`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p1, variantId: null }, src1.id, 5);
    const w = await stockLocationService.evacuateLocation(src1.id, { mode: "writeoff" });
    check("L1: active write-off → product touched", w.touchedProductIds.includes(p1));
    check("L1: active write-off → nothing restocked", w.restockedProductIds.length === 0);

    // L2: transfer between two ACTIVE locations nets to zero → not touched.
    const p2 = await mkProduct("l2", { stockQty: 0 });
    const src2 = await stockLocationService.create({ name: `${TAG}-l2src`, is_active: true } as never);
    const dest2 = await stockLocationService.create({ name: `${TAG}-l2dest`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p2, variantId: null }, src2.id, 6);
    const t = await stockLocationService.evacuateLocation(src2.id, { mode: "transfer", destinationId: dest2.id });
    check("L2: active-source transfer → no product touched (total unchanged)", !t.touchedProductIds.includes(p2));
    check("L2: active-source transfer → nothing restocked", t.restockedProductIds.length === 0);

    // L3: transfer OUT OF AN INACTIVE location puts its units back → touched +
    // restocked (the deactivation had sold the line out).
    const p3 = await mkProduct("l3", { stockQty: 0 });
    const src3 = await stockLocationService.create({ name: `${TAG}-l3src`, is_active: true } as never);
    const dest3 = await stockLocationService.create({ name: `${TAG}-l3dest`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p3, variantId: null }, src3.id, 4);
    await stockLocationService.setLocationActive(src3.id, false);
    const [pre3] = await db.select().from(products).where(eq(products.id, p3));
    check("L3 setup: deactivation took the line to 0 / out of stock", pre3.stock_qty === 0 && pre3.in_stock === false);
    const t3 = await stockLocationService.evacuateLocation(src3.id, { mode: "transfer", destinationId: dest3.id });
    check("L3: inactive-source transfer → product touched", t3.touchedProductIds.includes(p3));
    check("L3: inactive-source transfer → product restocked", t3.restockedProductIds.includes(p3));

    // L4: write-off of an INACTIVE location removes nothing more → not touched.
    const p4 = await mkProduct("l4", { stockQty: 0 });
    const src4 = await stockLocationService.create({ name: `${TAG}-l4src`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p4, variantId: null }, src4.id, 3);
    await stockLocationService.setLocationActive(src4.id, false);
    const w4 = await stockLocationService.evacuateLocation(src4.id, { mode: "writeoff" });
    check("L4: inactive-source write-off → no product touched", !w4.touchedProductIds.includes(p4));

    // softDelete reports a real deletion once (a second call is a no-op).
    check("L5: softDelete of a live non-default location → true", (await stockLocationService.softDelete(src1.id)) === true);
    check("L5: softDelete again → false (nothing to audit)", (await stockLocationService.softDelete(src1.id)) === false);

    // L6: a line failing MID-evacuation → EvacuatePartialError carrying what the
    // lines already committed changed (their levels are 0 now, so a retry would
    // not reselect them). The failing line is a crafted (product A, variant of
    // product B) level that _applyLevelTx's integrity guard refuses — inserted
    // AFTER the good line so the good one is moved first.
    const p6 = await mkProduct("l6", { stockQty: 0 });
    const p6bad = await mkProduct("l6bad", { stockQty: 0 });
    const p6other = await mkProduct("l6other", { stockQty: null, type: "variable" });
    await productService.replaceVariants(p6other, [mkV({ label: "X6", stockQty: 2, isDefault: true })]);
    const [v6] = await db
      .select({ id: product_variants.id })
      .from(product_variants)
      .where(and(eq(product_variants.product_id, p6other), isNull(product_variants.deleted_at)));
    const src6 = await stockLocationService.create({ name: `${TAG}-l6src`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p6, variantId: null }, src6.id, 5);
    await db.insert(stock_levels).values({ location_id: src6.id, product_id: p6bad, variant_id: v6.id, qty: 2 });
    let partial: unknown = null;
    try {
      await stockLocationService.evacuateLocation(src6.id, { mode: "writeoff" });
    } catch (err) {
      partial = err;
    }
    check("L6: part-way failure throws EvacuatePartialError", partial instanceof EvacuatePartialError);
    const pe = partial instanceof EvacuatePartialError ? partial : null;
    check("L6: keeps the original (French) message", pe?.message === "Variante introuvable pour ce produit.");
    const levelOf = async (productId: string) =>
      (
        await db
          .select({ qty: stock_levels.qty })
          .from(stock_levels)
          .where(and(eq(stock_levels.location_id, src6.id), eq(stock_levels.product_id, productId)))
      )[0]?.qty;
    check("L6 setup: the good line was moved first and committed (level 0)", (await levelOf(p6)) === 0);
    check("L6: the failing line rolled back (level still 2)", (await levelOf(p6bad)) === 2);
    check(
      "L6: carries the committed line's product as touched",
      pe != null && pe.touchedProductIds.length === 1 && pe.touchedProductIds[0] === p6,
    );
    check("L6: nothing restocked", pe != null && pe.restockedProductIds.length === 0);
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
