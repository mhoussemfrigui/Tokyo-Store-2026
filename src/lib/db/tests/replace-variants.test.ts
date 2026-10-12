import "server-only";

/**
 * replaceVariants reconciler regression test (rescan #9).
 *
 * replaceVariants is the trickiest product mutation: it pre-clears is_default and
 * pre-frees sku/gtin on every live variant to dodge immediate 23505 aborts on
 * the NON-deferrable partial unique indexes during default-moves and code swaps,
 * then soft-deletes leaving variants (stock_qty=0 / in_stock=false), reporting
 * each with the quantity it held (the caller's ledger step, A–Z 09-23). This test
 * pins those behaviours against a real transaction so a future refactor that
 * drops a pre-clear surfaces here, not as a spurious admin save failure.
 *
 * Run: pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *        src/lib/db/tests/replace-variants.test.ts
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { productService, type VariantInput } from "@/modules/catalog/product/service";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__rvtest";

async function cleanup() {
  await db.execute(sql`delete from product_variant_values where variant_id in (select id from product_variants where product_id in (select id from products where slug like ${TAG + "%"}))`);
  await db.execute(sql`delete from product_variants where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

function mkV(o: Partial<VariantInput> & { label: string }): VariantInput {
  return {
    id: null, sku: null, gtin: null, mpn: null, priceCents: 10_000, oldPriceCents: null,
    stockQty: 5, inStock: true, imageMediaId: null, displayOrder: 0, isDefault: false,
    attributeValueIds: [], ...o,
  };
}

async function live(pid: string) {
  return db
    .select()
    .from(product_variants)
    .where(and(eq(product_variants.product_id, pid), isNull(product_variants.deleted_at)))
    .orderBy(product_variants.display_order);
}
async function byId(id: string) {
  const [v] = await db.select().from(product_variants).where(eq(product_variants.id, id));
  return v;
}

async function main() {
  await cleanup();
  const [p] = await db
    .insert(products)
    .values({ slug: `${TAG}-p`, name: `${TAG} P`, price_cents: 10_000, product_type: "variable" } as never)
    .returning({ id: products.id });
  const pid = p.id;

  // Setup: 3 variants, DEFAULT on the LAST (C) — the case where moving it to an
  // earlier row is 23505-prone.
  await productService.replaceVariants(pid, [
    mkV({ label: "A", sku: `${TAG}-A`, displayOrder: 0 }),
    mkV({ label: "B", sku: `${TAG}-B`, displayOrder: 1 }),
    mkV({ label: "C", sku: `${TAG}-C`, displayOrder: 2, isDefault: true }),
  ]);
  const rows = await live(pid);
  check("setup: 3 live variants", rows.length === 3);
  const A = rows.find((v) => v.label === "A")!;
  const B = rows.find((v) => v.label === "B")!;
  const C = rows.find((v) => v.label === "C")!;
  check("setup: default is C (last)", C.is_default === true && A.is_default === false);

  // (a) Move default to an EARLIER variant (A).
  let threw = false;
  let resA: Awaited<ReturnType<typeof productService.replaceVariants>> | null = null;
  try {
    resA = await productService.replaceVariants(pid, [
      mkV({ id: A.id, label: "A", sku: `${TAG}-A`, displayOrder: 0, isDefault: true }),
      mkV({ id: B.id, label: "B", sku: `${TAG}-B`, displayOrder: 1 }),
      mkV({ id: C.id, label: "C", sku: `${TAG}-C`, displayOrder: 2 }),
    ]);
  } catch { threw = true; }
  check("(a) moving default to an earlier variant does not raise 23505", !threw);
  check("(a) nothing removed → removed: []", resA !== null && resA.removed.length === 0);
  check("(a) default moved to A", (await byId(A.id)).is_default === true && (await byId(C.id)).is_default === false);

  // (b) SWAP SKUs A <-> B.
  threw = false;
  try {
    await productService.replaceVariants(pid, [
      mkV({ id: A.id, label: "A", sku: `${TAG}-B`, displayOrder: 0, isDefault: true }),
      mkV({ id: B.id, label: "B", sku: `${TAG}-A`, displayOrder: 1 }),
      mkV({ id: C.id, label: "C", sku: `${TAG}-C`, displayOrder: 2 }),
    ]);
  } catch { threw = true; }
  check("(b) swapping SKUs A<->B does not raise 23505", !threw);
  check("(b) SKUs swapped", (await byId(A.id)).sku === `${TAG}-B` && (await byId(B.id)).sku === `${TAG}-A`);

  // (c) Reuse a LEAVING variant's SKU on a kept variant + (d) soft-delete C.
  // C holds 2 units (a sale moved it off the setup's 5) — the removed-row report
  // must carry that LIVE quantity, not a stale one, for the caller's ledger step.
  await db.update(product_variants).set({ stock_qty: 2 }).where(eq(product_variants.id, C.id));
  threw = false;
  let resC: Awaited<ReturnType<typeof productService.replaceVariants>> | null = null;
  try {
    resC = await productService.replaceVariants(pid, [
      mkV({ id: A.id, label: "A", sku: `${TAG}-C`, displayOrder: 0, isDefault: true }),
      mkV({ id: B.id, label: "B", sku: `${TAG}-A`, displayOrder: 1 }),
      // C omitted → leaves the set
    ]);
  } catch { threw = true; }
  check("(c) reusing a leaving variant's SKU on a kept variant does not raise 23505", !threw);
  check("(c) kept variant took the reused SKU", (await byId(A.id)).sku === `${TAG}-C`);
  const cRow = await byId(C.id);
  check("(d) removed variant is soft-deleted", cRow.deleted_at !== null);
  check("(d) removed variant stock zeroed + out of stock", cRow.stock_qty === 0 && cRow.in_stock === false);
  check("(d) two live variants remain", (await live(pid)).length === 2);
  check(
    "(d) removed variant reported with the qty it held before zeroing (caller ledgers −2)",
    resC !== null && resC.removed.length === 1 && resC.removed[0].id === C.id && resC.removed[0].stockQty === 2,
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
