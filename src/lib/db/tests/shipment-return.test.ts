import "server-only";

/**
 * « Retour d'expédition » (RTO) — a SHIPPED parcel that bounced back. Exercises
 * the real workflows against inserted orders:
 *   - create (kind='shipment') is allowed ONLY on a `shipped` order;
 *   - receiving it RESTOCKS the returned lines AND cancels the order (no double
 *     restock — it uses the return's own restock, not the cancel full-restock);
 *   - a « colis perdu » (restockable:false) line cancels WITHOUT restocking;
 *   - rejecting it (delivered after all) leaves the order `shipped`;
 *   - a second receive is an idempotent no-op.
 *
 * Self-cleaning (`__shipret…`). Run:
 *   export DATABASE_URL=$(grep ^DATABASE_URL= .env.development.local|cut -d= -f2-)
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/shipment-return.test.ts
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { orders, order_items, shipments, shipment_items } from "@/modules/order/schema";
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

const TAG = "__shipret";
const ACTOR = "__shipret-actor";

async function stockOf(productId: string): Promise<number | null> {
  const [r] = await db.select({ s: products.stock_qty }).from(products).where(eq(products.id, productId));
  return r?.s ?? null;
}
async function statusOf(orderId: string): Promise<string | null> {
  const [r] = await db.select({ s: orders.status }).from(orders).where(eq(orders.id, orderId));
  return r?.s ?? null;
}
async function returnStatusOf(returnId: string): Promise<string | null> {
  const r = await db.execute(sql`select status from order_returns where id = ${returnId}`);
  return (r.rows[0] as { status?: string } | undefined)?.status ?? null;
}
async function returnLedgerDelta(orderId: string): Promise<number> {
  const r = await db.execute(
    sql`select coalesce(sum(delta),0)::int as d from stock_movements where order_id = ${orderId} and reason = 'return'`,
  );
  return Number((r.rows[0] as { d?: number } | undefined)?.d ?? 0);
}

async function cleanup() {
  const mine = sql`(select id from orders where order_number like ${TAG + "%"})`;
  await db.execute(sql`delete from order_return_items where return_id in (select id from order_returns where order_id in ${mine})`);
  await db.execute(sql`delete from order_returns where order_id in ${mine}`);
  await db.execute(sql`delete from shipment_items where shipment_id in (select id from shipments where order_id in ${mine})`);
  await db.execute(sql`delete from shipments where order_id in ${mine}`);
  await db.execute(sql`delete from stock_movements where order_id in ${mine}`);
  await db.execute(sql`delete from order_status_history where order_id in ${mine}`);
  await db.execute(sql`delete from order_items where order_id in ${mine}`);
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

async function mkShippedOrder(tag: string, productId: string, qty: number, status = "shipped") {
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-${tag}-${Date.now()}-${Math.round(performance.now())}`,
      contact_email: "rto@example.com",
      status,
      payment_method: "cod",
      subtotal_cents: 10_000 * qty,
      total_cents: 10_000 * qty,
      ship_full_name: "RTO",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
    } as never)
    .returning({ id: orders.id });
  const [it] = await db
    .insert(order_items)
    .values({
      order_id: o.id,
      product_id: productId,
      product_name: `${TAG} ${tag}`,
      product_slug: `${TAG}-${tag}`,
      unit_price_cents: 10_000,
      quantity: qty,
      subtotal_cents: 10_000 * qty,
    } as never)
    .returning({ id: order_items.id });
  return { orderId: o.id, itemId: it.id };
}

async function main() {
  await cleanup();
  try {
    // ── 1) Happy path: shipped → create RTO → receive → restock + cancel ──────
    {
      const pid = await mkProduct("happy", 3);
      const { orderId, itemId } = await mkShippedOrder("happy", pid, 2);
      const created = await workflows.order.createReturn(
        { orderId, kind: "shipment", reasonCode: "customer_unreachable", carrierName: "Transporteur X", deliveryAttempts: 3, lines: [{ orderItemId: itemId, quantity: 2, restockable: true }] },
        { actorUserId: ACTOR },
      );
      check("create RTO on a shipped order succeeds", created.ok === true);
      const returnId = created.ok ? created.data.returnId : "";
      check("order still shipped before receipt", (await statusOf(orderId)) === "shipped");

      const recv = await workflows.order.receiveReturn({ returnId }, { actorUserId: ACTOR });
      check("receive succeeds", recv.ok === true);
      check("receive reports the order cancelled", recv.ok === true && recv.data.cancelledOrder === true);
      check("restocked +2 (3 → 5)", (await stockOf(pid)) === 5);
      check("ledger has a +2 return movement", (await returnLedgerDelta(orderId)) === 2);
      check("order is now cancelled", (await statusOf(orderId)) === "cancelled");
      check("return is received", (await returnStatusOf(returnId)) === "received");

      // Idempotent re-receive: no further restock, still cancelled.
      const recv2 = await workflows.order.receiveReturn({ returnId }, { actorUserId: ACTOR });
      check("re-receive is a no-op (restocked 0)", recv2.ok === true && recv2.data.restocked === 0);
      check("stock unchanged after re-receive (still 5)", (await stockOf(pid)) === 5);
    }

    // ── 2) Lost parcel: restockable:false → cancel WITHOUT restock ────────────
    {
      const pid = await mkProduct("lost", 4);
      const { orderId, itemId } = await mkShippedOrder("lost", pid, 2);
      const created = await workflows.order.createReturn(
        { orderId, kind: "shipment", reasonCode: "lost_in_transit", lines: [{ orderItemId: itemId, quantity: 2, restockable: false }] },
        { actorUserId: ACTOR },
      );
      const returnId = created.ok ? created.data.returnId : "";
      const recv = await workflows.order.receiveReturn({ returnId }, { actorUserId: ACTOR });
      check("lost parcel: receive cancels the order", recv.ok === true && recv.data.cancelledOrder === true);
      check("lost parcel: NO restock (stock stays 4)", (await stockOf(pid)) === 4);
      check("lost parcel: order cancelled", (await statusOf(orderId)) === "cancelled");
    }

    // ── 3) Refused on a non-shipped order ─────────────────────────────────────
    {
      const pid = await mkProduct("prep", 3);
      const { orderId, itemId } = await mkShippedOrder("prep", pid, 1, "preparing");
      const created = await workflows.order.createReturn(
        { orderId, kind: "shipment", lines: [{ orderItemId: itemId, quantity: 1, restockable: true }] },
        { actorUserId: ACTOR },
      );
      check("RTO refused on a non-shipped order", created.ok === false && created.error === "invalid_status");
      check("preparing order untouched", (await statusOf(orderId)) === "preparing");
    }

    // ── 4) Reject = delivered after all → order stays shipped ─────────────────
    {
      const pid = await mkProduct("reject", 3);
      const { orderId, itemId } = await mkShippedOrder("reject", pid, 1);
      const created = await workflows.order.createReturn(
        { orderId, kind: "shipment", reasonCode: "customer_absent", lines: [{ orderItemId: itemId, quantity: 1, restockable: true }] },
        { actorUserId: ACTOR },
      );
      const returnId = created.ok ? created.data.returnId : "";
      const rej = await workflows.order.rejectReturn({ returnId }, { actorUserId: ACTOR });
      check("reject succeeds", rej.ok === true);
      check("rejected RTO: order stays shipped", (await statusOf(orderId)) === "shipped");
      check("rejected RTO: no restock (stock stays 3)", (await stockOf(pid)) === 3);
      check("return is rejected", (await returnStatusOf(returnId)) === "rejected");
    }

    // ── 5) Invalid reason code for the kind is refused ────────────────────────
    {
      const pid = await mkProduct("badreason", 3);
      const { orderId, itemId } = await mkShippedOrder("badreason", pid, 1);
      const created = await workflows.order.createReturn(
        // 'changed_mind' is an after-sale code, not a shipment one.
        { orderId, kind: "shipment", reasonCode: "changed_mind", lines: [{ orderItemId: itemId, quantity: 1, restockable: true }] },
        { actorUserId: ACTOR },
      );
      check("cross-kind reason code is rejected", created.ok === false && created.error === "validation");
    }

    // ── 6) Stale receive: order left 'shipped' before receipt → refuse, no restock
    {
      const pid = await mkProduct("stale", 3);
      const { orderId, itemId } = await mkShippedOrder("stale", pid, 2);
      const created = await workflows.order.createReturn(
        { orderId, kind: "shipment", reasonCode: "customer_unreachable", lines: [{ orderItemId: itemId, quantity: 2, restockable: true }] },
        { actorUserId: ACTOR },
      );
      const returnId = created.ok ? created.data.returnId : "";
      // The parcel was actually delivered after all (operator moved it on).
      await db.update(orders).set({ status: "delivered" }).where(eq(orders.id, orderId));
      const recv = await workflows.order.receiveReturn({ returnId }, { actorUserId: ACTOR });
      check("stale RTO receive is refused (order no longer shipped)", recv.ok === false && recv.error === "conflict");
      check("stale RTO: NO restock (stock stays 3)", (await stockOf(pid)) === 3);
      check("stale RTO: order stays delivered", (await statusOf(orderId)) === "delivered");
      check("stale RTO: return stays pending", (await returnStatusOf(returnId)) === "pending");
    }

    // ── 7) Partially-shipped order → RTO create refused (remainder would strand)
    {
      const pid = await mkProduct("partial", 5);
      const { orderId, itemId } = await mkShippedOrder("partial", pid, 3);
      // A bon de livraison covering only 2 of the 3 ordered units.
      const [sh] = await db
        .insert(shipments)
        .values({ order_id: orderId, delivery_note_number: `${TAG}-BL-${Date.now()}`, shipped_at: new Date() } as never)
        .returning({ id: shipments.id });
      await db.insert(shipment_items).values({ shipment_id: sh.id, order_item_id: itemId, quantity: 2 } as never);
      const created = await workflows.order.createReturn(
        { orderId, kind: "shipment", reasonCode: "customer_unreachable", lines: [{ orderItemId: itemId, quantity: 2, restockable: true }] },
        { actorUserId: ACTOR },
      );
      check("partially-shipped order refuses an RTO", created.ok === false && created.error === "validation");
    }
  } finally {
    await cleanup();
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().then(() => process.exit(0));
