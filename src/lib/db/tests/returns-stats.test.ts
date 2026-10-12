import "server-only";

/**
 * Returns (retours) dashboard-stats test. Inserts a tagged order with two
 * returns (one received, one rejected) carrying a reason taxonomy + operator
 * comment, then verifies `returnService.dashboardStats` deltas (total, by-reason,
 * by-status, restock-rate bounds) and that `listAllWithOrder` surfaces the
 * tagged return with its order number, reason code and comment. Stats aggregate
 * GLOBALLY, so assertions use before/after deltas. Self-cleaning (`__rstest…`).
 * Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/returns-stats.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { orders, order_items } from "@/modules/order/schema";
import { order_returns, order_return_items } from "@/modules/order/returns.schema";
import { returnService } from "@/modules/order/returns.service";

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

const TAG = "__rstest";
const reasonCount = (rows: Array<{ code: string | null; count: number }>, code: string) =>
  rows.find((r) => r.code === code)?.count ?? 0;

async function cleanup() {
  await db.execute(
    sql`delete from order_return_items where return_id in (
          select r.id from order_returns r
          join orders o on o.id = r.order_id
          where o.order_number like ${TAG + "%"})`,
  );
  await db.execute(
    sql`delete from order_returns where order_id in (select id from orders where order_number like ${TAG + "%"})`,
  );
  await db.execute(sql`delete from order_items where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
}

async function main() {
  await cleanup();

  const before = await returnService.dashboardStats(3650);

  // A tagged order with one line.
  const [order] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-${Date.now()}`,
      contact_email: "rstest@example.com",
      status: "delivered",
      subtotal_cents: 100000,
      total_cents: 100000,
      ship_full_name: "RS Test",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
    } as never)
    .returning({ id: orders.id, number: orders.order_number });

  const [item] = await db
    .insert(order_items)
    .values({
      order_id: order.id,
      product_id: sql`uuid_generate_v7()` as never,
      product_name: `${TAG} Manette`,
      product_slug: `${TAG}-manette`,
      unit_price_cents: 100000,
      quantity: 2,
      subtotal_cents: 200000,
    } as never)
    .returning({ id: order_items.id, productId: order_items.product_id });

  // Return A — received, reason defective, with an operator comment.
  const [retA] = await db
    .insert(order_returns)
    .values({
      order_id: order.id,
      status: "received",
      reason_code: "defective",
      comment: `${TAG} écran mort à l'ouverture`,
    } as never)
    .returning({ id: order_returns.id });
  await db.insert(order_return_items).values({
    return_id: retA.id,
    order_item_id: item.id,
    product_id: item.productId,
    quantity: 1,
    restockable: false,
    condition_note: `${TAG} HS`,
  } as never);

  // Return B — rejected, reason defective too (so the by-reason delta is 2).
  const [retB] = await db
    .insert(order_returns)
    .values({ order_id: order.id, status: "rejected", reason_code: "defective" } as never)
    .returning({ id: order_returns.id });
  await db.insert(order_return_items).values({
    return_id: retB.id,
    order_item_id: item.id,
    product_id: item.productId,
    quantity: 1,
    restockable: true,
  } as never);

  const after = await returnService.dashboardStats(3650);

  // 1) total grew by exactly the 2 returns we added.
  check("total delta = 2", after.total - before.total === 2);

  // 2) by-reason 'defective' delta = 2.
  check(
    "by-reason defective delta = 2",
    reasonCount(after.byReason, "defective") - reasonCount(before.byReason, "defective") === 2,
  );

  // 3) by-status: +1 received, +1 rejected.
  check("received delta = 1", (after.byStatus.received ?? 0) - (before.byStatus.received ?? 0) === 1);
  check("rejected delta = 1", (after.byStatus.rejected ?? 0) - (before.byStatus.rejected ?? 0) === 1);

  // 4) restock rate is a sane percentage.
  check("restockRatePct in [0,100]", after.restockRatePct >= 0 && after.restockRatePct <= 100);

  // 5) return rate is a sane percentage (orders window includes our order).
  check("ordersInWindow includes the tagged order", after.ordersInWindow >= 1);
  check("returnRatePct in [0,100]", after.returnRatePct >= 0 && after.returnRatePct <= 100);
  // The tagged order has TWO returns but must count as ONE returned order — the
  // distinct-orders (not return-records) semantics that keeps the rate ≤ 100%.
  check(
    "returnedOrdersInWindow delta = 1 (2 returns on 1 order ⇒ +1, not +2)",
    after.returnedOrdersInWindow - before.returnedOrdersInWindow === 1,
  );
  // returnedOrdersInWindow is a subset of ordersInWindow ⇒ numerator never exceeds denominator.
  check(
    "returnedOrdersInWindow ≤ ordersInWindow",
    after.returnedOrdersInWindow <= after.ordersInWindow,
  );

  // 6) listAllWithOrder surfaces the tagged return with order number + comment.
  const list = await returnService.listAllWithOrder(500);
  const mine = list.filter((r) => r.orderNumber === order.number);
  check("listAllWithOrder returns both tagged returns", mine.length === 2);
  check("tagged return carries reason code", mine.every((r) => r.reasonCode === "defective"));
  check(
    "tagged return carries operator comment",
    mine.some((r) => r.comment?.startsWith(`${TAG} écran`)),
  );

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
