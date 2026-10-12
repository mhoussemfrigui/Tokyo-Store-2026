import "server-only";

/**
 * Variable→simple demotion must reset a NULL parent stock (rescan re-audit C1).
 *
 * When the admin main form demotes a variable product back to 'simple', a
 * variant-less ex-variable product whose parent stock_qty is NULL ("untracked /
 * always sellable") MUST be reset to a tracked, out-of-stock state — otherwise it
 * stays stock_qty=NULL + in_stock=true and becomes sellable in UNLIMITED quantity
 * (place-order skips both the qty check and the decrement on NULL stock).
 *
 * The subtlety this pins: the admin action ALWAYS sends the `stockQty` key (a blank
 * field ⇒ undefined), so `Object.keys(input)` always contains it. An earlier fix
 * guarded the reset on `!provided.has("stockQty")`, which is therefore always false
 * on the admin surface — the reset was dead there (oversell). The guard now keys off
 * the EFFECTIVE post-patch stock (`row.stock_qty === null`), matching the variant
 * editor's mirror. This test drives the real updateProduct workflow with the key
 * present-but-undefined (Case A) and with a real stock (Case B, control).
 *
 * Run: pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *        src/lib/db/tests/demote-variable-stock-reset.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { productService } from "@/modules/catalog/product/service";
import { workflows } from "@/workflows";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "zztest-demote";

async function cleanup() {
  await db.execute(sql`delete from stock_movements where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from product_variants where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

/** A published variable product with an UNTRACKED (NULL) parent stock + no variants. */
async function mkVariableNullStock(suffix: string): Promise<string> {
  const [row] = await db
    .insert(products)
    .values({
      slug: `${TAG}-${suffix}`,
      name: `${TAG} ${suffix}`,
      price_cents: 100_000,
      product_type: "variable",
      stock_qty: null,
      in_stock: true,
      is_published: true,
    } as never)
    .returning({ id: products.id });
  return row.id;
}

async function main() {
  await cleanup();

  // ── Case A (regression): demote with the stockQty KEY present but undefined ──
  // (the exact admin-main-form shape that made the old key-presence guard skip).
  const idA = await mkVariableNullStock("a");
  const preA = await productService.findById(idA);
  check("A setup: variable + NULL stock + in_stock", preA?.product_type === "variable" && preA?.stock_qty === null && preA?.in_stock === true);

  const rA = await workflows.catalog.updateProduct(
    { productId: idA, productType: "simple", stockQty: undefined },
    { actorUserId: `${TAG}-actor` },
  );
  check("A: update workflow ok", rA.ok === true);
  const afterA = await productService.findById(idA);
  check("A: demoted to simple", afterA?.product_type === "simple");
  check("A: NULL parent stock reset to 0 (no unlimited-sell oversell)", afterA?.stock_qty === 0);
  check("A: in_stock forced false", afterA?.in_stock === false);

  // ── Case B (control): a demotion that set a REAL stock keeps it (no clobber) ──
  const idB = await mkVariableNullStock("b");
  const rB = await workflows.catalog.updateProduct(
    { productId: idB, productType: "simple", stockQty: 7 },
    { actorUserId: `${TAG}-actor` },
  );
  check("B: update workflow ok", rB.ok === true);
  const afterB = await productService.findById(idB);
  check("B: demoted to simple", afterB?.product_type === "simple");
  check("B: real stock preserved (not reset to 0)", afterB?.stock_qty === 7);

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
