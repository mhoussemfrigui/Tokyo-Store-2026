import "server-only";

/**
 * Inter-location stock TRANSFERS (stockTransferService) — the lifecycle +
 * stock-move-on-completion. A transfer walks requested → accepted → in_transit →
 * completed; only completion moves stock (source level −qty, dest +qty, two
 * `transfer` ledger legs) and the authoritative product/variant TOTAL is
 * INVARIANT (units relocate). Illegal transitions, terminal states, and an
 * insufficient source are refused. Exercises the real service against a live DB.
 *
 * Self-cleaning (`__tr…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/stock-transfer.test.ts
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import type { EventPayload } from "@/events/types";
import { resolveSharedStockProductIds } from "@/lib/inventory/variant-stock";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { stock_levels } from "@/modules/stock-location/schema";
import { stockLocationService } from "@/modules/stock-location/service";
import { stock_movements } from "@/modules/stock-movement/schema";
import { stockTransferService } from "@/modules/stock-transfer";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__tr";

async function cleanup() {
  await db.execute(sql`delete from stock_transfer_items where transfer_id in (select id from stock_transfers where note like ${TAG + "%"})`);
  await db.execute(sql`delete from stock_transfers where note like ${TAG + "%"}`);
  await db.execute(sql`delete from stock_movements where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from stock_levels where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from stock_locations where name like ${TAG + "%"}`);
  await db.execute(sql`delete from product_variants where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

async function mkProduct(slug: string) {
  const [p] = await db
    .insert(products)
    .values({ slug: `${TAG}-${slug}`, name: `${TAG} ${slug}`, price_cents: 1000, stock_qty: 0, in_stock: true, is_published: true } as never)
    .returning({ id: products.id });
  return p.id;
}
async function mkVariant(productId: string, sku: string) {
  const [v] = await db
    .insert(product_variants)
    .values({ product_id: productId, sku: `${TAG}-${sku}`, label: sku, price_cents: 10_000, stock_qty: 0, in_stock: true } as never)
    .returning({ id: product_variants.id });
  return v.id;
}
async function totalOf(productId: string): Promise<number | null> {
  const [r] = await db.select({ s: products.stock_qty }).from(products).where(eq(products.id, productId));
  return r?.s ?? null;
}
async function levelAt(productId: string, locationId: string, variantId: string | null = null): Promise<number> {
  const [r] = await db
    .select({ q: stock_levels.qty })
    .from(stock_levels)
    .where(
      and(
        eq(stock_levels.product_id, productId),
        eq(stock_levels.location_id, locationId),
        variantId ? eq(stock_levels.variant_id, variantId) : isNull(stock_levels.variant_id),
      ),
    );
  return r?.q ?? 0;
}
async function transferLegs(productId: string) {
  return db
    .select({ delta: stock_movements.delta, locationId: stock_movements.location_id, reason: stock_movements.reason, note: stock_movements.note })
    .from(stock_movements)
    .where(and(eq(stock_movements.product_id, productId), eq(stock_movements.reason, "transfer")))
    .orderBy(stock_movements.created_at);
}
function expectThrow(fn: () => Promise<unknown>): Promise<boolean> {
  return fn().then(() => false, () => true);
}

async function main() {
  await cleanup();

  // ── T1: happy path — lifecycle + stock move on completion ──────────────────
  {
    const p = await mkProduct("t1");
    const src = await stockLocationService.create({ name: `${TAG}-t1src`, is_active: true } as never);
    const dest = await stockLocationService.create({ name: `${TAG}-t1dest`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, src.id, 5);
    check("T1: pre-transfer total = 5 (src 5, dest 0)", (await totalOf(p)) === 5);

    const tr = await stockTransferService.create({
      fromLocationId: src.id,
      toLocationId: dest.id,
      items: [{ productId: p, qty: 3 }],
      note: `${TAG} t1`,
    });
    check("T1: created status=requested, ref assigned", tr.status === "requested" && typeof tr.ref === "number" && tr.ref > 0);
    check("T1: no stock moved yet (src 5, dest 0)", (await levelAt(p, src.id)) === 5 && (await levelAt(p, dest.id)) === 0);

    await stockTransferService.transition(tr.id, "accepted");
    await stockTransferService.transition(tr.id, "in_transit");
    const done = await stockTransferService.transition(tr.id, "completed", { actorUserId: `${TAG}-actor` });
    check("T1: completed touched the product", done.touchedProductIds.includes(p));
    check("T1: source level 5 → 2", (await levelAt(p, src.id)) === 2);
    check("T1: destination level 0 → 3", (await levelAt(p, dest.id)) === 3);
    check("T1: cached TOTAL invariant at 5 (units relocated, not created/destroyed)", (await totalOf(p)) === 5);

    const legs = await transferLegs(p);
    check(
      "T1: two `transfer` ledger legs (−3 @ src, +3 @ dest) noting the transfer ref",
      legs.length === 2 &&
        legs.some((l) => l.delta === -3 && l.locationId === src.id) &&
        legs.some((l) => l.delta === 3 && l.locationId === dest.id) &&
        legs.every((l) => l.note === `Transfert TR-${tr.ref}`),
    );
  }

  // ── T2: illegal + terminal transitions are refused ─────────────────────────
  {
    const p = await mkProduct("t2");
    const src = await stockLocationService.create({ name: `${TAG}-t2src`, is_active: true } as never);
    const dest = await stockLocationService.create({ name: `${TAG}-t2dest`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, src.id, 4);
    const tr = await stockTransferService.create({ fromLocationId: src.id, toLocationId: dest.id, items: [{ productId: p, qty: 1 }], note: `${TAG} t2` });

    check("T2: requested → completed (skipping the flow) is refused", await expectThrow(() => stockTransferService.transition(tr.id, "completed")));
    check("T2: no stock moved by the refused transition", (await levelAt(p, src.id)) === 4 && (await levelAt(p, dest.id)) === 0);

    await stockTransferService.transition(tr.id, "cancelled", { cancelReason: "test" });
    check("T2: a cancelled transfer is terminal — a further transition throws", await expectThrow(() => stockTransferService.transition(tr.id, "accepted")));
    check("T2: cancel moved no stock", (await levelAt(p, src.id)) === 4 && (await totalOf(p)) === 4);
  }

  // ── T3: completion refused when the source can't cover a line (atomic) ─────
  {
    const p = await mkProduct("t3");
    const src = await stockLocationService.create({ name: `${TAG}-t3src`, is_active: true } as never);
    const dest = await stockLocationService.create({ name: `${TAG}-t3dest`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, src.id, 2);
    const tr = await stockTransferService.create({ fromLocationId: src.id, toLocationId: dest.id, items: [{ productId: p, qty: 10 }], note: `${TAG} t3` });
    await stockTransferService.transition(tr.id, "accepted");
    await stockTransferService.transition(tr.id, "in_transit");
    check("T3: completing a transfer the source can't cover throws", await expectThrow(() => stockTransferService.transition(tr.id, "completed")));
    check("T3: the failed completion moved NO stock (src 2, dest 0, total 2)", (await levelAt(p, src.id)) === 2 && (await levelAt(p, dest.id)) === 0 && (await totalOf(p)) === 2);
    const [row] = await db.select({ s: sql<string>`status` }).from(sql`stock_transfers`).where(sql`id = ${tr.id}`);
    check("T3: the transfer stays in_transit (not marked completed)", (row as { s: string }).s === "in_transit");
  }

  // ── T4: VARIANT transfer moves the variant level + variant total invariant ─
  {
    const p = await mkProduct("t4");
    const v = await mkVariant(p, "t4v");
    const src = await stockLocationService.create({ name: `${TAG}-t4src`, is_active: true } as never);
    const dest = await stockLocationService.create({ name: `${TAG}-t4dest`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: v }, src.id, 8);
    const tr = await stockTransferService.create({ fromLocationId: src.id, toLocationId: dest.id, items: [{ productId: p, variantId: v, qty: 5 }], note: `${TAG} t4` });
    await stockTransferService.transition(tr.id, "accepted");
    await stockTransferService.transition(tr.id, "in_transit");
    await stockTransferService.transition(tr.id, "completed");
    const [vt] = await db.select({ s: product_variants.stock_qty }).from(product_variants).where(eq(product_variants.id, v));
    check("T4: variant src 8 → 3, dest 0 → 5", (await levelAt(p, src.id, v)) === 3 && (await levelAt(p, dest.id, v)) === 5);
    check("T4: variant total invariant at 8", (vt?.s ?? null) === 8);
  }

  // ── T5: create validation — same-location + empty/zero lines rejected ──────
  {
    const p = await mkProduct("t5");
    const a = await stockLocationService.create({ name: `${TAG}-t5a`, is_active: true } as never);
    check("T5: from === to is rejected", await expectThrow(() => stockTransferService.create({ fromLocationId: a.id, toLocationId: a.id, items: [{ productId: p, qty: 1 }], note: `${TAG} t5` })));
    const b = await stockLocationService.create({ name: `${TAG}-t5b`, is_active: true } as never);
    check("T5: an all-zero-quantity transfer is rejected", await expectThrow(() => stockTransferService.create({ fromLocationId: a.id, toLocationId: b.id, items: [{ productId: p, qty: 0 }], note: `${TAG} t5` })));
  }

  // ── T6: cancelling an order cancels its NON-TERMINAL linked transfers only ──
  {
    const p = await mkProduct("t6");
    const src = await stockLocationService.create({ name: `${TAG}-t6src`, is_active: true } as never);
    const dest = await stockLocationService.create({ name: `${TAG}-t6dest`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, src.id, 10);
    const orderId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const pending = await stockTransferService.create({ fromLocationId: src.id, toLocationId: dest.id, items: [{ productId: p, qty: 1 }], orderId, note: `${TAG} t6a` });
    const done = await stockTransferService.create({ fromLocationId: src.id, toLocationId: dest.id, items: [{ productId: p, qty: 2 }], orderId, note: `${TAG} t6b` });
    await stockTransferService.transition(done.id, "accepted");
    await stockTransferService.transition(done.id, "in_transit");
    await stockTransferService.transition(done.id, "completed");

    const res = await stockTransferService.cancelPendingForOrder(orderId, { reason: "test" });
    check("T6: cancels the 1 non-terminal linked transfer (not the completed one)", res.cancelled === 1);
    check("T6: the pending transfer is now cancelled", (await stockTransferService.getById(pending.id))?.status === "cancelled");
    check("T6: the completed transfer is untouched", (await stockTransferService.getById(done.id))?.status === "completed");
  }

  // ── T7: create rejects lines whose product/variant don't resolve ───────────
  {
    const p = await mkProduct("t7");
    const other = await mkProduct("t7other");
    const vOfOther = await mkVariant(other, "t7v");
    const src = await stockLocationService.create({ name: `${TAG}-t7src`, is_active: true } as never);
    const dest = await stockLocationService.create({ name: `${TAG}-t7dest`, is_active: true } as never);
    const missing = "00000000-0000-0000-0000-0000000000ff";

    check(
      "T7: a variant belonging to ANOTHER product is rejected",
      await expectThrow(() =>
        stockTransferService.create({
          fromLocationId: src.id,
          toLocationId: dest.id,
          items: [{ productId: p, variantId: vOfOther, qty: 1 }],
          note: `${TAG} t7a`,
        }),
      ),
    );
    check(
      "T7: an unknown product id is rejected",
      await expectThrow(() =>
        stockTransferService.create({
          fromLocationId: src.id,
          toLocationId: dest.id,
          items: [{ productId: missing, qty: 1 }],
          note: `${TAG} t7b`,
        }),
      ),
    );
    check(
      "T7: an unknown variant id is rejected",
      await expectThrow(() =>
        stockTransferService.create({
          fromLocationId: src.id,
          toLocationId: dest.id,
          items: [{ productId: p, variantId: missing, qty: 1 }],
          note: `${TAG} t7c`,
        }),
      ),
    );
    // A well-formed line (variant of ITS product) still creates fine.
    const vp = await mkVariant(p, "t7vp");
    const ok = await stockTransferService.create({
      fromLocationId: src.id,
      toLocationId: dest.id,
      items: [{ productId: p, variantId: vp, qty: 1 }],
      note: `${TAG} t7d`,
    });
    check("T7: a variant of its own product still creates", ok.status === "requested");
  }

  // ── T8: resolveSharedStockProductIds — only variable products whose EXPLICIT
  //    override is on qualify (independent of the global default). ─────────────
  {
    const [rows] = [
      await db
        .insert(products)
        .values([
          { slug: `${TAG}-t8shared`, name: `${TAG} t8shared`, price_cents: 1000, product_type: "variable", shared_variant_stock: true, is_published: true },
          { slug: `${TAG}-t8pervar`, name: `${TAG} t8pervar`, price_cents: 1000, product_type: "variable", shared_variant_stock: false, is_published: true },
          { slug: `${TAG}-t8simple`, name: `${TAG} t8simple`, price_cents: 1000, product_type: "simple", shared_variant_stock: true, is_published: true },
        ] as never)
        .returning({ id: products.id, slug: products.slug }),
    ];
    const bySlug = new Map((rows as Array<{ id: string; slug: string }>).map((r) => [r.slug, r.id]));
    const sharedId = bySlug.get(`${TAG}-t8shared`)!;
    const perVarId = bySlug.get(`${TAG}-t8pervar`)!;
    const simpleId = bySlug.get(`${TAG}-t8simple`)!;

    const set = await resolveSharedStockProductIds([sharedId, perVarId, simpleId]);
    check("T8: variable + override on → in the shared set", set.has(sharedId));
    check("T8: variable + override off → NOT shared (override beats global default)", !set.has(perVarId));
    check("T8: simple product with override on → NOT shared (only variable products pool)", !set.has(simpleId));
    check("T8: empty input → empty set", (await resolveSharedStockProductIds([])).size === 0);
  }

  // ── T9: lifecycle events carry ERP keys (location codes + line sku/external_ref).
  //    No other emitter is live in this standalone test, so capture the latest. ─
  {
    let requested: EventPayload<"stock.transfer.requested"> | null = null;
    let completed: EventPayload<"stock.transfer.completed"> | null = null;
    bus.on("stock.transfer.requested", ({ payload }) => { requested = payload; });
    bus.on("stock.transfer.completed", ({ payload }) => { completed = payload; });

    const p = await mkProduct("t9");
    await db.update(products).set({ sku: `${TAG}-SKU9`, external_ref: `${TAG}-ERP9` }).where(eq(products.id, p));
    const src = await stockLocationService.create({ name: `${TAG}-t9src`, code: `${TAG}-SRC`, is_active: true } as never);
    const dest = await stockLocationService.create({ name: `${TAG}-t9dest`, code: `${TAG}-DST`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, src.id, 5);

    const tr = await stockTransferService.create({
      fromLocationId: src.id,
      toLocationId: dest.id,
      items: [{ productId: p, qty: 2 }],
      note: `${TAG} t9`,
    });
    const r = requested as EventPayload<"stock.transfer.requested"> | null;
    check(
      "T9: requested carries location codes + line sku/external_ref",
      r != null &&
        r.fromCode === `${TAG}-SRC` &&
        r.toCode === `${TAG}-DST` &&
        r.items.length === 1 &&
        r.items[0].sku === `${TAG}-SKU9` &&
        r.items[0].externalRef === `${TAG}-ERP9` &&
        r.items[0].qty === 2,
    );

    await stockTransferService.transition(tr.id, "accepted");
    await stockTransferService.transition(tr.id, "in_transit");
    await stockTransferService.transition(tr.id, "completed");
    const c = completed as EventPayload<"stock.transfer.completed"> | null;
    check(
      "T9: completed carries location codes + line sku/external_ref",
      c != null &&
        c.fromCode === `${TAG}-SRC` &&
        c.toCode === `${TAG}-DST` &&
        c.items.length === 1 &&
        c.items[0].sku === `${TAG}-SKU9` &&
        c.items[0].externalRef === `${TAG}-ERP9`,
    );
  }

  // ── T10: countsByStatus reflects a new transfer (delta) + list paginates ────
  {
    const before = await stockTransferService.countsByStatus();
    const p = await mkProduct("t10");
    const src = await stockLocationService.create({ name: `${TAG}-t10src`, is_active: true } as never);
    const dest = await stockLocationService.create({ name: `${TAG}-t10dest`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, src.id, 5);
    await stockTransferService.create({ fromLocationId: src.id, toLocationId: dest.id, items: [{ productId: p, qty: 1 }], note: `${TAG} t10` });
    const after = await stockTransferService.countsByStatus();
    check("T10: countsByStatus.requested increases by exactly 1", after.requested === before.requested + 1);

    const page1 = await stockTransferService.list({ pageSize: 2, page: 1 });
    check("T10: list respects pageSize (≤ 2) + echoes it", page1.items.length <= 2 && page1.pageSize === 2);
    check("T10: list total ≥ the rows shown", page1.total >= page1.items.length);
  }

  // ── T11: the order-cancel CASCADE emits stock.transfer.cancelled (the emit is
  //    centralized in the service, so cancelPendingForOrder announces too). ─────
  {
    let cancelledCount = 0;
    bus.on("stock.transfer.cancelled", () => { cancelledCount += 1; });

    const p = await mkProduct("t11");
    const src = await stockLocationService.create({ name: `${TAG}-t11src`, is_active: true } as never);
    const dest = await stockLocationService.create({ name: `${TAG}-t11dest`, is_active: true } as never);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, src.id, 10);
    const orderId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await stockTransferService.create({ fromLocationId: src.id, toLocationId: dest.id, items: [{ productId: p, qty: 1 }], orderId, note: `${TAG} t11` });

    const before = cancelledCount;
    const res = await stockTransferService.cancelPendingForOrder(orderId, { reason: "test cascade" });
    check("T11: cancelPendingForOrder cancelled the linked transfer", res.cancelled === 1);
    check("T11: the cascade emitted stock.transfer.cancelled", cancelledCount === before + 1);
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
