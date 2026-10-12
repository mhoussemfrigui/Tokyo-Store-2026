import "server-only";

/**
 * Sales-channel capture (Phase D P2, migration 0172). Verifies:
 *   - the channel is written from the placeOrderWorkflow CONTEXT, and the fallback
 *     derivation classifies each of the 4 creation paths (storefront / express /
 *     operator / erp) — an explicit context.channel wins, else operatorUserId ⇒
 *     operator, deliveryChannel:'operator' ⇒ erp, else storefront;
 *   - the DB column defaults to 'storefront' for a direct insert (tests / seed);
 *   - the admin list() channel filter + listFilterCounts().byChannel are correct.
 * Self-cleaning (`__sctest…`). Run against the isolated dev DB:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/order-sales-channel.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { carts, cart_items } from "@/modules/cart/schema";
import { orders } from "@/modules/order/schema";
import { orderService } from "@/modules/order/service";
import { workflows } from "@/workflows";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__sctest";
const EMAIL = "__sctest@example.test";

async function cleanup() {
  await db.execute(sql`delete from orders where contact_email = ${EMAIL} or order_number like ${TAG + "%"}`);
  await db.execute(sql`delete from cart_items where cart_id in (select id from carts where token like ${TAG + "%"})`);
  await db.execute(sql`delete from carts where token like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

/** Place an order through the workflow with a given context, return the created order row. */
async function placeWith(
  productId: string,
  token: string,
  ctx: Record<string, unknown>,
): Promise<{ ok: boolean; channel?: string; id?: string }> {
  const [cart] = await db.insert(carts).values({ token } as never).returning({ id: carts.id });
  await db.insert(cart_items).values({
    cart_id: cart.id,
    product_id: productId,
    variant_id: "",
    quantity: 1,
    unit_price_cents: 50000,
  } as never);
  const res = await workflows.order.place(
    {
      cartId: cart.id,
      contactEmail: EMAIL,
      shipping: { fullName: "SC Test", streetLine1: "1 rue", city: "Tunis", country: "TN" },
      deliveryMethod: "home_delivery",
      paymentMethod: "cod",
    } as never,
    ctx as never,
  );
  if (!res.ok) return { ok: false };
  const [row] = await db.select({ channel: orders.channel, id: orders.id }).from(orders).where(sql`${orders.id} = ${res.data.orderId}`);
  return { ok: true, channel: row.channel, id: row.id };
}

async function main() {
  await cleanup();

  const [product] = await db
    .insert(products)
    .values({ slug: `${TAG}-prod`, name: `${TAG} Article`, price_cents: 50000, stock_qty: 50, in_stock: true, is_published: true } as never)
    .returning({ id: products.id });

  // ── 1. Per-path channel capture / derivation ──────────────────────────────
  console.log("channel capture per creation path:");
  const store = await placeWith(product.id, `${TAG}-store`, { actorUserId: null });
  check("storefront: {actorUserId} → channel 'storefront'", store.ok && store.channel === "storefront");

  const express = await placeWith(product.id, `${TAG}-exp`, { actorUserId: null, channel: "express" });
  check("express: explicit channel:'express' → 'express'", express.ok && express.channel === "express");

  const operator = await placeWith(product.id, `${TAG}-op`, { actorUserId: null, operatorUserId: "__sctest-staff" });
  check("operator: {operatorUserId} derives → 'operator'", operator.ok && operator.channel === "operator");

  const erp = await placeWith(product.id, `${TAG}-erp`, { actorUserId: null, deliveryChannel: "operator" });
  check("erp: {deliveryChannel:'operator'} derives → 'erp'", erp.ok && erp.channel === "erp");

  const explicitWins = await placeWith(product.id, `${TAG}-win`, { actorUserId: null, operatorUserId: "__sctest-staff", channel: "erp" });
  check("explicit context.channel wins over derivation", explicitWins.ok && explicitWins.channel === "erp");

  // ── 2. DB default for a direct insert (tests / demo seed omit channel) ─────
  const [direct] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-direct`, contact_email: EMAIL, subtotal_cents: 1000, total_cents: 1000,
      ship_full_name: "D", ship_street_line1: "1", ship_city: "Tunis",
    } as never)
    .returning({ channel: orders.channel });
  check("direct insert (no channel) → defaults to 'storefront'", direct.channel === "storefront");

  // ── 3. list() channel filter + listFilterCounts().byChannel ───────────────
  console.log("admin list filter + counts:");
  // Restrict to our test rows via the search box (order_number/email) so the
  // assertions don't depend on the rest of the dev DB.
  const listExpress = await orderService.list({ channel: "express", search: EMAIL, limit: 100 });
  check("list({channel:'express'}) → only express orders", listExpress.items.every((o) => o.channel === "express") && listExpress.items.length >= 1);
  const listOperator = await orderService.list({ channel: "operator", search: EMAIL, limit: 100 });
  check("list({channel:'operator'}) → only operator orders", listOperator.items.every((o) => o.channel === "operator") && listOperator.items.length >= 1);
  const listAll = await orderService.list({ search: EMAIL, limit: 100 });
  check("list() with no channel → mixed channels present", new Set(listAll.items.map((o) => o.channel)).size >= 3);

  const counts = await orderService.listFilterCounts({ search: EMAIL });
  check("counts.byChannel has express ≥ 1", (counts.byChannel.express ?? 0) >= 1);
  check("counts.byChannel has operator ≥ 1", (counts.byChannel.operator ?? 0) >= 1);
  check("counts.byChannel has erp ≥ 1", (counts.byChannel.erp ?? 0) >= 1);
  check(
    "counts.byChannel sums to the total (channels partition the base)",
    Object.values(counts.byChannel).reduce((a, b) => a + (b ?? 0), 0) === counts.total,
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
