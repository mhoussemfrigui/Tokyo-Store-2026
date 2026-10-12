import "server-only";

/**
 * Operator order-line editing + partial-shipment test. Exercises the real
 * workflows against inserted orders + tracked stock:
 *   EDIT — set_qty increase decrements stock; decrease restocks; remove restocks
 *          + drops the line; add decrements a new line's stock; removing every
 *          line is blocked (≥1 line); subtotal recomputes.
 *   SHIP — partial shipment records shipped qty + draws a gapless BL; over-ship
 *          is blocked; after partial ship a line can't be removed/reduced below
 *          shipped; cancel is blocked once a shipment exists; markShipped on the
 *          final parcel transitions the order to "shipped".
 *   ATOMIC — a multi-op batch whose later stock claim fails rolls back the
 *          earlier release (stock, ledger, lines + totals all unchanged).
 *   REFUND — a FULLY refunded order refuses line edits, new parcels and forward
 *          status moves (the refund already restocked it) but can still be
 *          cancelled without a second restock; a PARTIAL refund caps how far
 *          an edit may shrink the total.
 * Self-cleaning (`__editship…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/order-edit-ship.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { orders, order_items } from "@/modules/order/schema";
import { orderService } from "@/modules/order/service";
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

const TAG = "__editship";

async function stockOf(productId: string): Promise<number | null> {
  const [r] = await db.select({ s: products.stock_qty }).from(products).where(sql`${products.id} = ${productId}`);
  return r?.s ?? null;
}
async function subtotalOf(orderId: string): Promise<number> {
  const [r] = await db.select({ s: orders.subtotal_cents }).from(orders).where(sql`${orders.id} = ${orderId}`);
  return r?.s ?? -1;
}
async function lineCount(orderId: string): Promise<number> {
  const rows = await orderService.listItems(orderId);
  return rows.length;
}
async function movementCount(orderId: string): Promise<number> {
  const r = await db.execute(sql`select count(*)::int as n from stock_movements where order_id = ${orderId}`);
  return Number((r.rows[0] as { n: number }).n);
}
/** Turn a test order into a SETTLED upfront (cash) order with a real total. */
async function markPaid(orderId: string, status: "paid" | "preparing", totalCents: number) {
  await db.execute(
    sql`update orders set status = ${status}, payment_method = 'cash', paid_at = now(), subtotal_cents = ${totalCents}, total_cents = ${totalCents} where id = ${orderId}`,
  );
}

async function cleanup() {
  await db.execute(sql`delete from shipment_items where shipment_id in (select id from shipments where order_id in (select id from orders where order_number like ${TAG + "%"}))`);
  await db.execute(sql`delete from shipments where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from stock_movements where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from order_refunds where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from order_status_history where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from order_items where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

async function mkProduct(slug: string, price: number, stock: number) {
  const [p] = await db
    .insert(products)
    .values({ slug: `${TAG}-${slug}`, name: `${TAG} ${slug}`, price_cents: price, stock_qty: stock, in_stock: true, is_published: true } as never)
    .returning({ id: products.id });
  return p.id;
}

async function mkOrder(tag: string) {
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-${tag}-${Date.now()}`,
      contact_email: "es@example.com",
      status: "preparing",
      payment_method: "cod",
      subtotal_cents: 0,
      total_cents: 0,
      ship_full_name: "ES",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
    } as never)
    .returning({ id: orders.id });
  return o.id;
}

async function mkItem(orderId: string, productId: string, qty: number, unit: number) {
  const [it] = await db
    .insert(order_items)
    .values({
      order_id: orderId,
      product_id: productId,
      product_name: `${TAG} line`,
      product_slug: `${TAG}-line`,
      unit_price_cents: unit,
      quantity: qty,
      subtotal_cents: unit * qty,
    } as never)
    .returning({ id: order_items.id });
  return it.id;
}

async function main() {
  await cleanup();

  const pA = await mkProduct("a", 1000, 8); // 2 already "sold"
  const pB = await mkProduct("b", 2000, 4); // 1 already "sold"
  const pC = await mkProduct("c", 1500, 5);

  // ── EDIT ──────────────────────────────────────────────────────────────────
  const order = await mkOrder("edit");
  const itemA = await mkItem(order, pA, 2, 1000);
  const itemB = await mkItem(order, pB, 1, 2000);

  // set_qty A 2→4 (decrement 2): stock 8→6, subtotal 4000→6000.
  const r1 = await workflows.order.editItems({ orderId: order, ops: [{ kind: "set_qty", orderItemId: itemA, quantity: 4 }] }, { actorUserId: null });
  check("edit: set_qty increase ok", r1.ok === true);
  check("edit: increase decremented stock 8→6", (await stockOf(pA)) === 6);
  check("edit: subtotal 4000→6000", (await subtotalOf(order)) === 6000);

  // set_qty A 4→1 (restock 3): stock 6→9, subtotal 6000→3000.
  const r2 = await workflows.order.editItems({ orderId: order, ops: [{ kind: "set_qty", orderItemId: itemA, quantity: 1 }] }, { actorUserId: null });
  check("edit: set_qty decrease ok", r2.ok === true);
  check("edit: decrease restocked stock 6→9", (await stockOf(pA)) === 9);
  check("edit: subtotal 6000→3000", (await subtotalOf(order)) === 3000);

  // remove B (restock 1): stock 4→5, order now 1 line, subtotal 3000→1000.
  const r3 = await workflows.order.editItems({ orderId: order, ops: [{ kind: "remove", orderItemId: itemB }] }, { actorUserId: null });
  check("edit: remove ok", r3.ok === true);
  check("edit: remove restocked B 4→5", (await stockOf(pB)) === 5);
  check("edit: line count 2→1", (await lineCount(order)) === 1);
  check("edit: subtotal 3000→1000", (await subtotalOf(order)) === 1000);

  // add C qty2 (decrement 2): C stock 5→3, order 2 lines, subtotal 1000→4000.
  const r4 = await workflows.order.editItems({ orderId: order, ops: [{ kind: "add", productId: pC, quantity: 2 }] }, { actorUserId: null });
  check("edit: add ok", r4.ok === true);
  check("edit: add decremented C 5→3", (await stockOf(pC)) === 3);
  check("edit: line count 1→2", (await lineCount(order)) === 2);
  check("edit: subtotal 1000→4000 (1000 + 2×1500)", (await subtotalOf(order)) === 4000);

  // Regression: a tracked product must round-trip stock on add→remove (a
  // removed line restocks the units it claimed). pD: stock 3.
  const pD = await mkProduct("d", 3000, 3);
  const addD = await workflows.order.editItems({ orderId: order, ops: [{ kind: "add", productId: pD, quantity: 1 }] }, { actorUserId: null });
  check("edit: add ok", addD.ok === true);
  check("edit: add decremented stock 3→2", (await stockOf(pD)) === 2);
  const dLine = (await orderService.listItems(order)).find((i) => i.product_id === pD);
  const rmD = await workflows.order.editItems({ orderId: order, ops: [{ kind: "remove", orderItemId: dLine!.id }] }, { actorUserId: null });
  check("edit: remove ok", rmD.ok === true);
  check("edit: remove RESTOCKED 2→3 (no leak)", (await stockOf(pD)) === 3);

  // Guard: removing every line is blocked.
  const itemsNow = await orderService.listItems(order);
  const removeAll = await workflows.order.editItems({ orderId: order, ops: itemsNow.map((i) => ({ kind: "remove" as const, orderItemId: i.id })) }, { actorUserId: null });
  check("edit: removing all lines blocked", removeAll.ok === false);

  // Guard: two ops on the SAME line in one batch are rejected (no double-apply).
  const dupOps = await workflows.order.editItems({ orderId: order, ops: [{ kind: "set_qty", orderItemId: itemsNow[0].id, quantity: 2 }, { kind: "set_qty", orderItemId: itemsNow[0].id, quantity: 3 }] }, { actorUserId: null });
  check("edit: duplicate ops on one line blocked", dupOps.ok === false && dupOps.error === "validation");

  // ── SHIP ──────────────────────────────────────────────────────────────────
  const shipOrder = await mkOrder("ship");
  const sItemA = await mkItem(shipOrder, pA, 4, 1000);

  // Partial ship 2 of 4.
  const ship1 = await workflows.order.createShipment({ orderId: shipOrder, lines: [{ orderItemId: sItemA, quantity: 2 }] }, { actorUserId: null });
  check("ship: partial shipment ok", ship1.ok === true);
  check("ship: BL number drawn", ship1.ok === true && /^[A-Z0-9]+-\d{4}-\d{6}$/.test(ship1.data.deliveryNoteNumber));
  check("ship: shipped qty = 2", (await orderService.shippedQtyByItem(shipOrder)).get(sItemA) === 2);
  check("ship: not fully shipped → still preparing", (await orderService.findById(shipOrder))?.status === "preparing");

  // Over-ship: 3 more would exceed the remaining 2.
  const over = await workflows.order.createShipment({ orderId: shipOrder, lines: [{ orderItemId: sItemA, quantity: 3 }] }, { actorUserId: null });
  check("ship: over-ship blocked", over.ok === false && over.error === "exceeds_remaining");

  // Edit can't reduce below shipped (2).
  const reduceBelow = await workflows.order.editItems({ orderId: shipOrder, ops: [{ kind: "set_qty", orderItemId: sItemA, quantity: 1 }] }, { actorUserId: null });
  check("ship: edit below shipped blocked", reduceBelow.ok === false && reduceBelow.error === "exceeds_remaining");

  // Cancel is blocked once a shipment exists.
  const cancel = await workflows.order.transitionStatus({ orderId: shipOrder, toStatus: "cancelled" }, { actorUserId: null });
  check("ship: cancel blocked when shipped", cancel.ok === false && cancel.error === "conflict");

  // Ship the remaining 2 with markShipped → fully shipped → status "shipped".
  const ship2 = await workflows.order.createShipment({ orderId: shipOrder, lines: [{ orderItemId: sItemA, quantity: 2 }], markShipped: true }, { actorUserId: null });
  check("ship: final parcel ok", ship2.ok === true && ship2.data.fullyShipped === true);
  check("ship: order transitioned to shipped", (await orderService.findById(shipOrder))?.status === "shipped");

  // HIGH-regression: shipping fully from a PAID (online) order with markShipped
  // must advance paid→preparing→shipped, not strand it in paid.
  const paidOrder = await mkOrder("paid");
  await db.execute(sql`update orders set status = 'paid', payment_method = 'clictopay' where id = ${paidOrder}`);
  const pItem = await mkItem(paidOrder, pC, 1, 1500);
  const shipPaid = await workflows.order.createShipment({ orderId: paidOrder, lines: [{ orderItemId: pItem, quantity: 1 }], markShipped: true }, { actorUserId: null });
  check("ship: paid order fully-shipped ok", shipPaid.ok === true && shipPaid.data.fullyShipped === true);
  check("ship: paid order advanced to shipped (not stranded)", (await orderService.findById(paidOrder))?.status === "shipped");

  // ── ATOMIC: a later claim failing must roll back an earlier release ─────────
  // Stock ops apply in lock-key (id) order, so the RELEASE target must sort
  // first. Two fresh products; the lower id gets stock + the line to remove, the
  // higher id is sold out and gets the line whose qty is raised.
  {
    const x = await mkProduct("atom-x", 1000, 5);
    const y = await mkProduct("atom-y", 1000, 0);
    const [relP, claimP] = x < y ? [x, y] : [y, x];
    await db.execute(sql`update products set stock_qty = 5 where id = ${relP}`);
    await db.execute(sql`update products set stock_qty = 0 where id = ${claimP}`);
    const atomOrder = await mkOrder("atom");
    const relLine = await mkItem(atomOrder, relP, 2, 1000);
    const claimLine = await mkItem(atomOrder, claimP, 1, 1000);
    await db.execute(sql`update orders set subtotal_cents = 3000, total_cents = 3000 where id = ${atomOrder}`);
    const movesBefore = await movementCount(atomOrder);
    const batch = await workflows.order.editItems(
      {
        orderId: atomOrder,
        ops: [
          { kind: "remove", orderItemId: relLine }, // release +2 (applied FIRST)
          { kind: "set_qty", orderItemId: claimLine, quantity: 3 }, // claim 2 of 0 → fails
        ],
      },
      { actorUserId: null },
    );
    check("atomic: batch with a failing later claim → conflict", batch.ok === false && batch.error === "conflict");
    check("atomic: earlier release rolled back (stock still 5)", (await stockOf(relP)) === 5);
    check("atomic: failed claim left stock at 0", (await stockOf(claimP)) === 0);
    check("atomic: no ledger rows committed", (await movementCount(atomOrder)) === movesBefore);
    check("atomic: both lines still on the order", (await lineCount(atomOrder)) === 2);
    check("atomic: totals unchanged", (await subtotalOf(atomOrder)) === 3000);
  }

  // ── REFUND: a fully refunded order is locked for edit / ship / forward ──────
  {
    const pR = await mkProduct("refund", 1000, 5);
    const refOrder = await mkOrder("refund");
    const refLine = await mkItem(refOrder, pR, 2, 1000);
    await markPaid(refOrder, "paid", 2000);
    const refund = await workflows.order.refund({ orderId: refOrder, amountCents: 2000 }, { actorUserId: "__editship-actor" });
    check("refund: full refund ok", refund.ok === true);
    check("refund: unshipped order restocked by the refund 5→7", (await stockOf(pR)) === 7);

    const rm = await workflows.order.editItems({ orderId: refOrder, ops: [{ kind: "remove", orderItemId: refLine }] }, { actorUserId: null });
    check("refund: edit (shrink) of a fully refunded order refused", rm.ok === false && rm.error === "conflict");
    const grow = await workflows.order.editItems({ orderId: refOrder, ops: [{ kind: "set_qty", orderItemId: refLine, quantity: 3 }] }, { actorUserId: null });
    check("refund: edit (grow) of a fully refunded order refused", grow.ok === false && grow.error === "conflict");
    check("refund: no second restock / claim (stock still 7)", (await stockOf(pR)) === 7);

    const shipRef = await workflows.order.createShipment({ orderId: refOrder, lines: [{ orderItemId: refLine, quantity: 2 }], markShipped: true }, { actorUserId: null });
    check("refund: new parcel on a fully refunded order refused", shipRef.ok === false && shipRef.error === "conflict");
    check("refund: no shipment recorded", (await orderService.countShipments(refOrder)) === 0);

    const fwd = await workflows.order.transitionStatus({ orderId: refOrder, toStatus: "preparing" }, { actorUserId: null });
    check("refund: forward move (paid→preparing) refused", fwd.ok === false && fwd.error === "conflict");
    check("refund: status still paid", (await orderService.findById(refOrder))?.status === "paid");

    const cancelRef = await workflows.order.transitionStatus({ orderId: refOrder, toStatus: "cancelled" }, { actorUserId: null });
    check("refund: cancel still allowed", cancelRef.ok === true);
    check("refund: cancel does NOT restock again (stock still 7)", (await stockOf(pR)) === 7);
  }

  // ── PARTIAL REFUND: edits allowed, but the total can't sink to the refunded sum
  {
    const pS = await mkProduct("partial-s", 1000, 5);
    const pT = await mkProduct("partial-t", 3000, 5);
    const partOrder = await mkOrder("partial");
    await mkItem(partOrder, pS, 1, 1000);
    const tLine = await mkItem(partOrder, pT, 1, 3000);
    await markPaid(partOrder, "paid", 4000);
    const partial = await workflows.order.refund({ orderId: partOrder, amountCents: 2000 }, { actorUserId: "__editship-actor" });
    check("partial: partial refund ok (no restock)", partial.ok === true && (await stockOf(pS)) === 5);
    const shrink = await workflows.order.editItems({ orderId: partOrder, ops: [{ kind: "remove", orderItemId: tLine }] }, { actorUserId: null });
    check("partial: shrinking the total (1000) below the refunded 2000 refused", shrink.ok === false && shrink.error === "conflict");
    check("partial: refused shrink left T's stock alone (5)", (await stockOf(pT)) === 5);
    // A refund implies `paid_at`: the total is the captured amount and may no
    // longer move (orderTotalLock) — growing is refused too, stock untouched.
    const grow = await workflows.order.editItems({ orderId: partOrder, ops: [{ kind: "set_qty", orderItemId: tLine, quantity: 2 }] }, { actorUserId: null });
    check("partial: growing a settled (paid) order refused — total locked", grow.ok === false && grow.error === "conflict" && (await stockOf(pT)) === 5);
  }

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
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
