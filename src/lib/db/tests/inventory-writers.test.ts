import "server-only";

/**
 * Core stock WRITERS + their ledger contract (A–Z 09-23, P2 test gaps) — the
 * paths the ERP-facing `/api/stock` and the SAV return flow rely on:
 *   A. applyStockDelta fails CLOSED: an untracked line → `untracked`, an
 *      over-remove → `insufficient` — neither writes the row nor the ledger;
 *      a success returns the new qty and ledgers it with the same resulting_qty.
 *   B. applyStockSet only ledgers an ACTUAL quantity change: a same-value set (or
 *      an in_stock-only set) appends NO delta:0 row; a real set ledgers
 *      after − before.
 *   C. receiveReturn on a SHARED-pool variable product restocks the PARENT pool
 *      and ledgers a product-level row (variant_id NULL, the pool's resulting
 *      qty, the variant kept in the note) — so Σ(delta) per (product, variant)
 *      stays reconcilable against stock_qty.
 *
 * Self-cleaning (`__invw…`). Run ONLY against a throwaway DB:
 *   DATABASE_URL=… pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/inventory-writers.test.ts
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { applyStockDelta, applyStockSet } from "@/lib/inventory/adjust";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { orders, order_items } from "@/modules/order/schema";
import { stock_movements } from "@/modules/stock-movement/schema";
import { workflows } from "@/workflows";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__invw";

async function cleanup() {
  const mine = sql`(select id from products where slug like ${TAG + "%"})`;
  const myOrders = sql`(select id from orders where order_number like ${TAG + "%"})`;
  await db.execute(sql`delete from order_return_items where return_id in (select id from order_returns where order_id in ${myOrders})`);
  await db.execute(sql`delete from order_returns where order_id in ${myOrders}`);
  await db.execute(sql`delete from stock_movements where order_id in ${myOrders}`);
  await db.execute(sql`delete from order_status_history where order_id in ${myOrders}`);
  await db.execute(sql`delete from order_items where order_id in ${myOrders}`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
  await db.execute(sql`delete from stock_movements where product_id in ${mine}`);
  await db.execute(sql`delete from product_variants where product_id in ${mine}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

async function mkProduct(
  slug: string,
  o: { stock: number | null; type?: "simple" | "variable"; shared?: boolean | null },
) {
  const [p] = await db
    .insert(products)
    .values({
      slug: `${TAG}-${slug}`,
      name: `${TAG} ${slug}`,
      price_cents: 10_000,
      stock_qty: o.stock,
      in_stock: true,
      is_published: true,
      product_type: o.type ?? "simple",
      shared_variant_stock: o.shared ?? null,
    } as never)
    .returning({ id: products.id });
  return p.id;
}

async function stockOf(productId: string): Promise<number | null> {
  const [r] = await db.select({ s: products.stock_qty }).from(products).where(eq(products.id, productId));
  return r?.s ?? null;
}

async function ledger(productId: string) {
  return db
    .select({
      delta: stock_movements.delta,
      resultingQty: stock_movements.resulting_qty,
      reason: stock_movements.reason,
      variantId: stock_movements.variant_id,
      note: stock_movements.note,
    })
    .from(stock_movements)
    .where(eq(stock_movements.product_id, productId))
    .orderBy(stock_movements.created_at);
}

async function main() {
  await cleanup();

  // ── A. applyStockDelta ──────────────────────────────────────────────────────
  {
    const untracked = await mkProduct("a-untracked", { stock: null });
    const r1 = await applyStockDelta({ kind: "product", rowId: untracked, productId: untracked }, 2, { reason: "api_delta" });
    check("A1: delta on an UNTRACKED line → ok:false code 'untracked'", !r1.ok && r1.code === "untracked");
    check("A1: …stays untracked, nothing ledgered", (await stockOf(untracked)) === null && (await ledger(untracked)).length === 0);

    const p = await mkProduct("a-tracked", { stock: 3 });
    const r2 = await applyStockDelta({ kind: "product", rowId: p, productId: p }, -5, { reason: "api_delta" });
    check("A2: over-remove (3 − 5) → ok:false code 'insufficient'", !r2.ok && r2.code === "insufficient");
    check("A2: …stock unchanged at 3, nothing ledgered", (await stockOf(p)) === 3 && (await ledger(p)).length === 0);

    const r3 = await applyStockDelta({ kind: "product", rowId: p, productId: p }, -2, { reason: "api_delta", note: `${TAG} erp` });
    check("A3: a valid −2 → ok, resultingQty 1", r3.ok && r3.resultingQty === 1 && (await stockOf(p)) === 1);
    const rows = await ledger(p);
    check(
      "A3: one api_delta ledger row −2 with resulting_qty 1 (= the returned qty)",
      rows.length === 1 && rows[0].delta === -2 && rows[0].resultingQty === 1 && rows[0].reason === "api_delta",
    );

    const r4 = await applyStockDelta({ kind: "product", rowId: p, productId: p }, -1, { reason: "api_delta" });
    check("A4: removing exactly the last unit is allowed (→ 0)", r4.ok && r4.resultingQty === 0);
  }

  // ── B. applyStockSet ledger discipline ──────────────────────────────────────
  {
    const p = await mkProduct("b-set", { stock: 7 });
    await applyStockSet({ kind: "product", rowId: p, productId: p }, { setQty: 7 }, { reason: "api_set" });
    check("B1: a same-value set (7 → 7) writes NO ledger row", (await ledger(p)).length === 0);
    await applyStockSet({ kind: "product", rowId: p, productId: p }, { setInStock: false }, { reason: "api_set" });
    check("B2: an in_stock-only set writes NO ledger row", (await ledger(p)).length === 0);
    const r = await applyStockSet({ kind: "product", rowId: p, productId: p }, { setQty: 10 }, { reason: "api_set" });
    const rows = await ledger(p);
    check("B3: a real set 7 → 10 returns 10", r.resultingQty === 10 && (await stockOf(p)) === 10);
    check("B3: …ledgers delta +3 (after − before), resulting 10", rows.length === 1 && rows[0].delta === 3 && rows[0].resultingQty === 10);
  }

  // ── C. receiveReturn on a SHARED-pool variable product ─────────────────────
  {
    const p = await mkProduct("c-shared", { stock: 5, type: "variable", shared: true });
    const [v] = await db
      .insert(product_variants)
      .values({ product_id: p, sku: `${TAG}-c-v`, label: "C", price_cents: 10_000, stock_qty: 0, in_stock: true } as never)
      .returning({ id: product_variants.id });
    const [o] = await db
      .insert(orders)
      .values({
        order_number: `${TAG}-c-${Date.now()}`,
        contact_email: "invw@example.com",
        status: "delivered",
        payment_method: "cod",
        paid_at: new Date(),
        subtotal_cents: 20_000,
        total_cents: 20_000,
        ship_full_name: "INVW",
        ship_street_line1: "1 rue",
        ship_city: "Tunis",
      } as never)
      .returning({ id: orders.id });
    const [item] = await db
      .insert(order_items)
      .values({
        order_id: o.id,
        product_id: p,
        variant_id: v.id,
        variant_label: "C",
        product_name: `${TAG} line`,
        product_slug: `${TAG}-line`,
        unit_price_cents: 10_000,
        quantity: 2,
        subtotal_cents: 20_000,
      } as never)
      .returning({ id: order_items.id });

    const ret = await workflows.order.createReturn(
      { orderId: o.id, lines: [{ orderItemId: item.id, quantity: 2, restockable: true }] },
      { actorUserId: null },
    );
    check("C: return on the delivered shared-pool order accepted", ret.ok === true);
    if (ret.ok) {
      const recv = await workflows.order.receiveReturn({ returnId: ret.data.returnId }, { actorUserId: null });
      check("C: receive ok, 1 line restocked", recv.ok === true && recv.data.restocked === 1);
      check("C: the PARENT pool is restocked 5 → 7", (await stockOf(p)) === 7);
      const [vRow] = await db.select({ s: product_variants.stock_qty }).from(product_variants).where(eq(product_variants.id, v.id));
      check("C: the shared variant's own stock_qty is untouched (0)", vRow?.s === 0);
      const rows = await db
        .select({ delta: stock_movements.delta, resultingQty: stock_movements.resulting_qty, variantId: stock_movements.variant_id, note: stock_movements.note })
        .from(stock_movements)
        .where(and(eq(stock_movements.order_id, o.id), eq(stock_movements.reason, "return")));
      check(
        "C: ONE product-level return row: variant_id NULL, +2, resulting = pool qty 7",
        rows.length === 1 && rows[0].variantId === null && rows[0].delta === 2 && rows[0].resultingQty === 7,
      );
      check("C: the variant stays traceable in the note", rows.length === 1 && (rows[0].note ?? "").includes(v.id));
    }
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
