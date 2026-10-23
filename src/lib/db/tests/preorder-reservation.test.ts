import "server-only";

/**
 * Précommande reservation stock-integrity test (Phase 3). Exercises the REAL
 * placement + conversion + unwind workflows against inserted tracked stock:
 *   S1 — placing an ACTIVE-preorder line RESERVES units: no stock is decremented,
 *        `reserved_qty` bumps by the ordered qty, the order + line carry the
 *        preorder flags (`stock_claimed=false`), and ONE 'open' hold is written.
 *   S2 — CONVERTING the order (release) consumes the hold: real stock is now
 *        decremented, `reserved_qty` drops back, a 'consumed' hold + a `reason:
 *        'order'` movement are recorded, and the order/line flip to a normal
 *        (claimed, non-preorder) sale with `preorder_converted_at` stamped. A
 *        second convert is a no-op (idempotent).
 *   S3 — CANCELLING before conversion RELEASES the hold: `reserved_qty` drops,
 *        the hold is 'released', and stock is NEITHER decremented NOR restocked
 *        (the units were never taken).
 *   S4 — a full REFUND before conversion likewise RELEASES the hold with no stock
 *        movement.
 *
 * Self-cleaning (`__preres…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/preorder-reservation.test.ts
 */
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { orders, order_items } from "@/modules/order/schema";
import { carts, cart_items } from "@/modules/cart/schema";
import { stock_reservations } from "@/modules/stock-reservation";
import { workflows } from "@/workflows";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__preres";
const ACTOR = `${TAG}-actor`;

async function cleanup() {
  const mine = sql`(select id from orders where contact_phone = ${TAG})`;
  await db.execute(sql`delete from stock_reservations where order_id in ${mine}`);
  await db.execute(sql`delete from stock_movements where order_id in ${mine}`);
  await db.execute(sql`delete from order_status_history where order_id in ${mine}`);
  await db.execute(sql`delete from order_refunds where order_id in ${mine}`);
  await db.execute(sql`delete from order_items where order_id in ${mine}`);
  await db.execute(sql`delete from orders where contact_phone = ${TAG}`);
  await db.execute(sql`delete from cart_items where cart_id in (select id from carts where token like ${TAG + "%"})`);
  await db.execute(sql`delete from carts where token like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

/** A tracked, published product flagged as an ACTIVE preorder (release in 30 days). */
async function mkPreorderProduct(slug: string, stock: number): Promise<string> {
  const releasesAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const [p] = await db
    .insert(products)
    .values({
      slug: `${TAG}-${slug}`,
      name: `${TAG} ${slug}`,
      price_cents: 10_000,
      stock_qty: stock,
      in_stock: true,
      is_published: true,
      is_preorder: true,
      preorder_releases_at: releasesAt,
    } as never)
    .returning({ id: products.id });
  return p.id;
}

async function placePreorder(token: string, productId: string, qty: number) {
  const [cart] = await db.insert(carts).values({ token: `${TAG}-${token}` } as never).returning({ id: carts.id });
  await db.insert(cart_items).values({
    cart_id: cart.id,
    product_id: productId,
    variant_id: "",
    quantity: qty,
    unit_price_cents: 10_000,
  } as never);
  return workflows.order.place(
    {
      cartId: cart.id,
      contactEmail: "preres@example.com",
      contactPhone: TAG,
      shipping: { fullName: "Preres Test", streetLine1: "1 rue", city: "Tunis", country: "TN" },
      deliveryMethod: "home_delivery",
      paymentMethod: "cod",
    },
    { actorUserId: null },
  );
}

async function stockOf(productId: string): Promise<number | null> {
  const [r] = await db.select({ s: products.stock_qty }).from(products).where(eq(products.id, productId));
  return r?.s ?? null;
}
async function reservedOf(productId: string): Promise<number> {
  const [r] = await db.select({ r: products.reserved_qty }).from(products).where(eq(products.id, productId));
  return r?.r ?? -1;
}
async function holds(orderId: string, state?: string) {
  const where = state
    ? and(eq(stock_reservations.order_id, orderId), eq(stock_reservations.state, state))
    : eq(stock_reservations.order_id, orderId);
  return db.select().from(stock_reservations).where(where);
}
async function orderRow(orderId: string) {
  const [o] = await db.select().from(orders).where(eq(orders.id, orderId));
  return o;
}
async function lineRow(orderId: string) {
  const [l] = await db.select().from(order_items).where(eq(order_items.order_id, orderId));
  return l;
}
async function movementCount(orderId: string): Promise<number> {
  const [{ n }] = (await db.execute(sql`select count(*)::int as n from stock_movements where order_id = ${orderId}`)).rows as Array<{ n: number }>;
  return Number(n);
}

async function main() {
  await cleanup();

  // ── S1 + S2: place reserves (no decrement) → convert decrements + consumes ──
  {
    const p = await mkPreorderProduct("s1", 10);
    const placed = await placePreorder("s1", p, 2);
    check("S1: preorder placed ok", placed.ok === true);
    if (!placed.ok) { await cleanup(); console.log(`\n=== done: ${passed} passed, ${failed} failed ===`); process.exit(1); }
    const orderId = placed.data.orderId;

    check("S1: stock NOT decremented at placement (stays 10)", (await stockOf(p)) === 10);
    check("S1: reserved_qty bumped to 2", (await reservedOf(p)) === 2);
    check("S1: order flagged is_preorder", (await orderRow(orderId)).is_preorder === true);
    check("S1: line stock_claimed = false (never decremented)", (await lineRow(orderId)).stock_claimed === false);
    const open = await holds(orderId, "open");
    check("S1: exactly ONE open hold, qty 2, on the product pool", open.length === 1 && open[0].qty === 2 && open[0].variant_id === null);
    check("S1: no stock movement recorded at placement", (await movementCount(orderId)) === 0);

    // Convert (release).
    const conv = await workflows.order.convertPreorder({ orderId }, { actorUserId: ACTOR });
    check("S2: convert ok + converted", conv.ok === true && conv.ok && conv.data.converted === true);
    check("S2: stock decremented 10 → 8", (await stockOf(p)) === 8);
    check("S2: reserved_qty dropped back to 0", (await reservedOf(p)) === 0);
    check("S2: hold now consumed (no open left)", (await holds(orderId, "open")).length === 0 && (await holds(orderId, "consumed")).length === 1);
    check("S2: one stock movement recorded (the deferred sale decrement)", (await movementCount(orderId)) === 1);
    const o2 = await orderRow(orderId);
    check("S2: order no longer preorder + converted_at stamped", o2.is_preorder === false && o2.preorder_converted_at != null);
    const l2 = await lineRow(orderId);
    check("S2: line flipped to claimed + non-preorder", l2.stock_claimed === true && l2.is_preorder === false);

    // Idempotent second convert.
    const again = await workflows.order.convertPreorder({ orderId }, { actorUserId: ACTOR });
    check("S2: second convert is a no-op (converted=false)", again.ok === true && again.ok && again.data.converted === false);
    check("S2: stock unchanged after re-convert (stays 8)", (await stockOf(p)) === 8);
  }

  // ── S3: cancel before conversion releases the hold (no decrement/restock) ──
  {
    const p = await mkPreorderProduct("s3", 10);
    const placed = await placePreorder("s3", p, 3);
    check("S3: preorder placed ok", placed.ok === true);
    if (placed.ok) {
      const orderId = placed.data.orderId;
      check("S3: reserved 3, stock stays 10", (await reservedOf(p)) === 3 && (await stockOf(p)) === 10);
      const cancel = await workflows.order.transitionStatus({ orderId, toStatus: "cancelled" }, { actorUserId: null });
      check("S3: cancel ok", cancel.ok === true);
      check("S3: hold released (none open, one released)", (await holds(orderId, "open")).length === 0 && (await holds(orderId, "released")).length === 1);
      check("S3: reserved_qty back to 0", (await reservedOf(p)) === 0);
      check("S3: stock NEITHER decremented NOR restocked (stays 10)", (await stockOf(p)) === 10);
      check("S3: no stock movement on an unconverted cancel", (await movementCount(orderId)) === 0);
    }
  }

  // ── S4: full refund before conversion releases the hold (no stock movement) ──
  {
    const p = await mkPreorderProduct("s4", 10);
    const placed = await placePreorder("s4", p, 2);
    check("S4: preorder placed ok", placed.ok === true);
    if (placed.ok) {
      const orderId = placed.data.orderId;
      const total = (await orderRow(orderId)).total_cents;
      // Make it refundable (COD preorders aren't paid at placement).
      await db.update(orders).set({ paid_at: new Date(), status: "paid" }).where(eq(orders.id, orderId));
      const refund = await workflows.order.refund({ orderId, amountCents: total }, { actorUserId: ACTOR });
      check("S4: full refund ok", refund.ok === true);
      check("S4: hold released", (await holds(orderId, "open")).length === 0 && (await holds(orderId, "released")).length === 1);
      check("S4: reserved_qty back to 0", (await reservedOf(p)) === 0);
      check("S4: stock unchanged (never decremented, nothing to restock)", (await stockOf(p)) === 10);
      check("S4: no stock movement from the preorder refund", (await movementCount(orderId)) === 0);
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
