import "server-only";

/**
 * Refund / returns stock-integrity test (A-Z re-audit Phase 4). Exercises the
 * real workflows against inserted paid orders + tracked stock:
 *   S1 — a FULL refund of a PARTIALLY-SHIPPED order restocks only the UNSHIPPED
 *        remainder (ordered − shipped), not the whole line.
 *   S2 — a return on a shipment-less order that was already fully REFUNDED is
 *        rejected (its stock was already restored by the refund → no double-restock).
 *   S3 — when the order HAS shipments, a return is capped by the SHIPPED qty
 *        (not the ordered qty); receive restocks exactly the shipped units, so
 *        refund(remainder) + return(shipped) restore exactly the placed quantity.
 *   S4 — a full refund of a delivered order with no BL restocks nothing; the
 *        goods coming back later ARE returnable (S4b) and restock on receive.
 *   S5 — a delivered no-BL order partially refunded CANNOT be marked « Remboursée »
 *        (full-refund label). Topped up to full while still `delivered`, the refund
 *        restocks nothing (the goods left — history-based); the flip to `refunded`
 *        follows, and a later return still restocks only what physically came back.
 *   S6 — a paid, never-shipped order partially refunded CANNOT be marked
 *        « Remboursée »; the top-up to full restocks the goods exactly once, then it
 *        flips to `refunded`, and a return is refused (history-based, nothing shipped).
 *
 * Self-cleaning (`__refstk…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/refund-restock-remainder.test.ts
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { orders, order_items } from "@/modules/order/schema";
import { workflows } from "@/workflows";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__refstk";

async function stockOf(productId: string): Promise<number | null> {
  const [r] = await db.select({ s: products.stock_qty }).from(products).where(eq(products.id, productId));
  return r?.s ?? null;
}

async function cleanup() {
  await db.execute(sql`delete from order_return_items where return_id in (select id from order_returns where order_id in (select id from orders where order_number like ${TAG + "%"}))`);
  await db.execute(sql`delete from order_returns where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from shipment_items where shipment_id in (select id from shipments where order_id in (select id from orders where order_number like ${TAG + "%"}))`);
  await db.execute(sql`delete from shipments where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from stock_movements where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from order_refunds where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from order_status_history where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from order_items where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

async function mkProduct(slug: string, stock: number) {
  const [p] = await db
    .insert(products)
    .values({ slug: `${TAG}-${slug}`, name: `${TAG} ${slug}`, price_cents: 10_000, stock_qty: stock, in_stock: true, is_published: true } as never)
    .returning({ id: products.id });
  return p.id;
}

// A PAID order (paid_at set so refund is allowed; status controls returnability).
async function mkPaidOrder(tag: string, status: string, total: number) {
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-${tag}-${Date.now()}-${Math.floor(total)}`,
      contact_email: "rs@example.com",
      status,
      payment_method: "cod",
      paid_at: new Date(),
      subtotal_cents: total,
      total_cents: total,
      ship_full_name: "RS",
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

  // ── S1: partial-ship full-refund restocks only the unshipped remainder ──────
  {
    const p = await mkProduct("s1", 5);            // on-shelf stock 5
    const o = await mkPaidOrder("s1", "paid", 20_000);
    const item = await mkItem(o, p, 2, 10_000);    // ordered 2
    const ship = await workflows.order.createShipment(
      { orderId: o, lines: [{ orderItemId: item, quantity: 1 }] }, // ship 1 of 2
      { actorUserId: null },
    );
    check("S1: partial shipment created", ship.ok === true);
    const refund = await workflows.order.refund({ orderId: o, amountCents: 20_000 }, { actorUserId: "__refstk-actor" });
    check("S1: full refund ok", refund.ok === true);
    check("S1: only the UNSHIPPED remainder (1) is restocked → 5→6", (await stockOf(p)) === 6);
  }

  // ── S2: return on a shipment-less FULLY-REFUNDED order is rejected. The guard
  // keys on the refund LEDGER, not status==='refunded' — so it must fire even when
  // the operator leaves the order at 'delivered' after the full refund (the
  // realistic path; a status-based guard would miss it and double-restock). ─────
  {
    const p = await mkProduct("s2", 5);
    const o = await mkPaidOrder("s2", "paid", 20_000);
    const item = await mkItem(o, p, 2, 10_000);
    const refund = await workflows.order.refund({ orderId: o, amountCents: 20_000 }, { actorUserId: "__refstk-actor" });
    check("S2: full refund ok", refund.ok === true);
    check("S2: unshipped order fully restocked → 5→7", (await stockOf(p)) === 7);
    // Mark it DELIVERED (a returnable status) WITHOUT setting 'refunded' — the
    // refund ledger still shows it fully refunded.
    await db.update(orders).set({ status: "delivered" }).where(eq(orders.id, o));
    const ret = await workflows.order.createReturn(
      { orderId: o, lines: [{ orderItemId: item, quantity: 2 }] },
      { actorUserId: null },
    );
    check("S2: return on a fully-refunded shipment-less order is REJECTED (ledger, not status)", ret.ok === false);
    check("S2: stock unchanged by the rejected return (still 7)", (await stockOf(p)) === 7);

    // S2b: a PARTIALLY-refunded shipment-less delivered order is still returnable
    // (the refund didn't restore the full quantity).
    const p2 = await mkProduct("s2b", 5);
    const o2 = await mkPaidOrder("s2b", "delivered", 20_000);
    const item2 = await mkItem(o2, p2, 2, 10_000);
    await workflows.order.refund({ orderId: o2, amountCents: 5_000 }, { actorUserId: "__refstk-actor" }); // partial
    const ret2 = await workflows.order.createReturn(
      { orderId: o2, lines: [{ orderItemId: item2, quantity: 1 }] },
      { actorUserId: null },
    );
    check("S2b: partial-refund shipment-less delivered order return is ACCEPTED", ret2.ok === true);
  }

  // ── S3: return is capped by SHIPPED qty; receive restocks only shipped ───────
  {
    const p = await mkProduct("s3", 5);
    const o = await mkPaidOrder("s3", "paid", 30_000);
    const item = await mkItem(o, p, 3, 10_000);    // ordered 3
    const ship = await workflows.order.createShipment(
      { orderId: o, lines: [{ orderItemId: item, quantity: 2 }] }, // ship 2 of 3
      { actorUserId: null },
    );
    check("S3: partial shipment (2 of 3) created", ship.ok === true);
    // Force a returnable status (a partially-shipped order marked delivered).
    await db.update(orders).set({ status: "delivered" }).where(eq(orders.id, o));

    const tooMany = await workflows.order.createReturn(
      { orderId: o, lines: [{ orderItemId: item, quantity: 3 }] }, // > shipped
      { actorUserId: null },
    );
    check("S3: returning MORE than shipped (3 > 2) is rejected", tooMany.ok === false);

    const okRet = await workflows.order.createReturn(
      { orderId: o, lines: [{ orderItemId: item, quantity: 2, restockable: true }] },
      { actorUserId: null },
    );
    check("S3: returning up to the shipped qty (2) is accepted", okRet.ok === true);
    if (okRet.ok) {
      const recv = await workflows.order.receiveReturn({ returnId: okRet.data.returnId }, { actorUserId: null });
      check("S3: receive restocks the 2 returned units → 5→7", recv.ok === true && (await stockOf(p)) === 7);
    }
  }

  // ── S4: full refund of a DELIVERED order with NO bon de livraison must NOT
  // restock — the goods are with the customer (fulfilment was recorded via the
  // status dropdown, which writes no shipment_items). Auto-restocking the whole
  // quantity here would inflate sellable stock (oversell). Physical returns are
  // recovered through the SAV flow instead. ────────────────────────────────────
  {
    const p = await mkProduct("s4", 5);
    const o = await mkPaidOrder("s4", "delivered", 20_000); // delivered, no shipments
    await mkItem(o, p, 2, 10_000);                          // ordered 2
    const refund = await workflows.order.refund({ orderId: o, amountCents: 20_000 }, { actorUserId: "__refstk-actor" });
    check("S4: full refund ok", refund.ok === true);
    check("S4: delivered no-BL full refund does NOT restock (stock stays 5)", (await stockOf(p)) === 5);

    // S4b: that refund restored nothing, so the watch coming back must still be
    // returnable (it's the only way back to sellable stock) — and restock once.
    const [line] = await db.select({ id: order_items.id }).from(order_items).where(eq(order_items.order_id, o));
    const ret = await workflows.order.createReturn(
      { orderId: o, lines: [{ orderItemId: line.id, quantity: 2, restockable: true }] },
      { actorUserId: null },
    );
    check("S4b: return after a full non-restocking refund is ACCEPTED", ret.ok === true);
    if (ret.ok) {
      const recv = await workflows.order.receiveReturn({ returnId: ret.data.returnId }, { actorUserId: null });
      check("S4b: receive restocks the 2 returned units once → 5→7", recv.ok === true && (await stockOf(p)) === 7);
    }
  }

  // ── S5: a partial refund can NOT be marked « Remboursée » (that status is a
  // FULL-refund label — the server now enforces what the UI already did; a partial
  // relabel would drop the order's un-refunded revenue). The legitimate flow tops
  // up to a full refund while the status is still `delivered`, then flips to
  // `refunded`. A full refund on a delivered (shipped) order must NOT restock the
  // goods that left; a later return still restocks the physically-returned unit. ──
  {
    const p = await mkProduct("s5", 5);
    const o = await mkPaidOrder("s5", "delivered", 20_000); // delivered, no BL
    const item = await mkItem(o, p, 2, 10_000);
    const part = await workflows.order.refund({ orderId: o, amountCents: 5_000 }, { actorUserId: "__refstk-actor" });
    check("S5: partial refund ok", part.ok === true);
    const markPartial = await workflows.order.transitionStatus({ orderId: o, toStatus: "refunded" }, { actorUserId: null });
    check("S5: partial refund → « Remboursée » REJECTED (full refund required)", markPartial.ok === false);
    const topUp = await workflows.order.refund({ orderId: o, amountCents: 15_000 }, { actorUserId: "__refstk-actor" });
    check("S5: top-up to a FULL refund ok (status still delivered)", topUp.ok === true);
    check("S5: full refund on a delivered (shipped) order does NOT restock goods that left (stock stays 5)", (await stockOf(p)) === 5);
    const mark = await workflows.order.transitionStatus({ orderId: o, toStatus: "refunded" }, { actorUserId: null });
    check("S5: delivered → refunded allowed once FULLY refunded", mark.ok === true);
    const ret = await workflows.order.createReturn(
      { orderId: o, lines: [{ orderItemId: item, quantity: 1, restockable: true }] },
      { actorUserId: null },
    );
    check("S5: return still accepted after the full (non-restocking) refund", ret.ok === true);
    if (ret.ok) {
      const recv = await workflows.order.receiveReturn({ returnId: ret.data.returnId }, { actorUserId: null });
      check("S5: receive restocks exactly the returned unit → 5→6", recv.ok === true && (await stockOf(p)) === 6);
    }
  }

  // ── S6: paid, never shipped. Same rule — a partial refund can't be marked
  // « Remboursée ». Topping up to a FULL refund (while status is still `paid`)
  // restocks the never-shipped goods exactly ONCE; the flip to `refunded` follows.
  // A return on a never-shipped order is refused (nothing left to return), so the
  // restock is never double-counted. ─────────────────────────────────────────────
  {
    const p = await mkProduct("s6", 5);
    const o = await mkPaidOrder("s6", "paid", 20_000);  // paid, never shipped
    const item = await mkItem(o, p, 2, 10_000);
    const part = await workflows.order.refund({ orderId: o, amountCents: 5_000 }, { actorUserId: "__refstk-actor" });
    check("S6: partial refund ok (no restock yet)", part.ok === true && (await stockOf(p)) === 5);
    const markPartial = await workflows.order.transitionStatus({ orderId: o, toStatus: "refunded" }, { actorUserId: null });
    check("S6: partial refund → « Remboursée » REJECTED (full refund required)", markPartial.ok === false);
    const topUp = await workflows.order.refund({ orderId: o, amountCents: 15_000 }, { actorUserId: "__refstk-actor" });
    check("S6: top-up to a FULL refund ok", topUp.ok === true);
    check("S6: full refund restocks the never-shipped goods exactly once → 5→7", (await stockOf(p)) === 7);
    const mark = await workflows.order.transitionStatus({ orderId: o, toStatus: "refunded" }, { actorUserId: null });
    check("S6: paid → refunded allowed once FULLY refunded", mark.ok === true);
    const ret = await workflows.order.createReturn(
      { orderId: o, lines: [{ orderItemId: item, quantity: 2, restockable: true }] },
      { actorUserId: null },
    );
    check("S6: return on a never-shipped order is REFUSED", ret.ok === false);
    const [{ n }] = (await db.execute(sql`select count(*)::int as n from order_returns where order_id = ${o}`)).rows as Array<{ n: number }>;
    check("S6: no return row written", Number(n) === 0);
    check("S6: stock unchanged by the refused return (stays 7)", (await stockOf(p)) === 7);
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
