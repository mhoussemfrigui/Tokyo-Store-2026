import "server-only";

/**
 * Manual / offline-paid order test. Builds an ephemeral cart and places it via
 * placeOrderWorkflow with an OFFLINE payment method, then verifies the
 * operator-created order behaves correctly:
 *   - the order is created + stock decremented (full workflow guarantees)
 *   - `cash` (offline counter) is UPFRONT-paid → pending→paid is allowed and
 *     stamps paid_at + payment_reference
 *   - `cod` stays pay-on-delivery → pending→paid is REJECTED (still deferred)
 *   - OPERATOR attribution: with `operatorUserId`, the staff member (not the
 *     customer, not nobody) is the audit actor of the creation — initial
 *     status-history row + stock movement — while `user_id` stays the customer;
 *     without it (self-checkout) the customer remains the actor.
 * Self-cleaning (`__motest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/manual-order.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { carts, cart_items } from "@/modules/cart/schema";
import { orders } from "@/modules/order/schema";
import { users } from "@/modules/auth/schema";
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

const TAG = "__motest";
const EMAIL = "motest@example.com";
const OPERATOR = `${TAG}-operator`;
const CUSTOMER = `${TAG}-customer`;

// Placed orders get real CMD-… numbers, so they are matched by their contact
// email (the TAG never appears in the order number).
async function cleanup() {
  await db.execute(sql`delete from stock_movements where order_id in (select id from orders where contact_email = ${EMAIL})`);
  await db.execute(sql`delete from order_status_history where order_id in (select id from orders where contact_email = ${EMAIL})`);
  await db.execute(sql`delete from order_items where order_id in (select id from orders where contact_email = ${EMAIL})`);
  await db.execute(sql`delete from orders where contact_email = ${EMAIL}`);
  await db.execute(sql`delete from cart_items where cart_id in (select id from carts where token like ${TAG + "%"})`);
  await db.execute(sql`delete from carts where token like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from audit_log where actor_user_id in (${OPERATOR}, ${CUSTOMER})`);
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
}

/** Actor + notes of the initial « Commande créée » row, and the stock-movement actor. */
async function creationAudit(orderId: string) {
  const h = await db.execute(
    sql`select actor_user_id as actor, notes from order_status_history where order_id = ${orderId} and from_status is null`,
  );
  const m = await db.execute(sql`select actor_user_id as actor from stock_movements where order_id = ${orderId}`);
  const [o] = await db.select({ userId: orders.user_id }).from(orders).where(sql`${orders.id} = ${orderId}`);
  const row = (h.rows as Array<{ actor: string | null; notes: string | null }>)[0];
  return {
    historyActor: row?.actor ?? null,
    notes: row?.notes ?? null,
    movementActors: (m.rows as Array<{ actor: string | null }>).map((r) => r.actor),
    userId: o?.userId ?? null,
  };
}

async function placeOffline(
  productId: string,
  method: "cash" | "cod",
  token: string,
  ctx: { actorUserId: string | null; operatorUserId?: string | null } = { actorUserId: null },
) {
  const [cart] = await db.insert(carts).values({ token } as never).returning({ id: carts.id });
  await db.insert(cart_items).values({
    cart_id: cart.id,
    product_id: productId,
    variant_id: "",
    quantity: 2,
    unit_price_cents: 50000,
  } as never);
  return workflows.order.place(
    {
      cartId: cart.id,
      contactEmail: EMAIL,
      shipping: { fullName: "MO Test", streetLine1: "1 rue", city: "Tunis", country: "TN" },
      deliveryMethod: "home_delivery",
      paymentMethod: method,
    },
    ctx,
  );
}

async function main() {
  await cleanup();

  const [product] = await db
    .insert(products)
    .values({ slug: `${TAG}-prod`, name: `${TAG} Article`, price_cents: 50000, stock_qty: 11, in_stock: true, is_published: true } as never)
    .returning({ id: products.id });

  // ── Offline CASH order → created, stock decremented, then markable PAID.
  const cashPlaced = await placeOffline(product.id, "cash", `${TAG}-cash`);
  check("cash: order placed", cashPlaced.ok === true);
  if (!cashPlaced.ok) {
    await cleanup();
    console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
    process.exit(1);
  }

  const [afterPlace] = await db.select({ stock: products.stock_qty }).from(products).where(sql`${products.id} = ${product.id}`);
  check("cash: stock decremented 11 → 9", afterPlace.stock === 9);

  const [created] = await db.select().from(orders).where(sql`${orders.id} = ${cashPlaced.data.orderId}`);
  check("cash: payment_method = cash", created.payment_method === "cash");
  check("cash: starts pending", created.status === "pending");

  // cash is UPFRONT → pending→paid allowed.
  const paid = await workflows.order.transitionStatus(
    { orderId: cashPlaced.data.orderId, toStatus: "paid", paymentReference: "Espèces — reçu#1" },
    { actorUserId: null },
  );
  check("cash: pending→paid allowed", paid.ok === true);
  const [afterPaid] = await db.select().from(orders).where(sql`${orders.id} = ${cashPlaced.data.orderId}`);
  check("cash: status now paid", afterPaid.status === "paid");
  check("cash: paid_at stamped", afterPaid.paid_at != null);
  check("cash: payment_reference stored", afterPaid.payment_reference === "Espèces — reçu#1");

  // ── Offline COD order → stays deferred; pending→paid REJECTED.
  const codPlaced = await placeOffline(product.id, "cod", `${TAG}-cod`);
  check("cod: order placed", codPlaced.ok === true);
  if (codPlaced.ok) {
    const codPaid = await workflows.order.transitionStatus(
      { orderId: codPlaced.data.orderId, toStatus: "paid" },
      { actorUserId: null },
    );
    check("cod: pending→paid REJECTED (still pay-on-delivery)", codPaid.ok === false);
  }

  // ── Operator attribution (manual order / caisse).
  await db.insert(users).values({ id: CUSTOMER, email: `${CUSTOMER}@example.test`, name: "MO Client" } as never);

  // Guest COD order created by an operator: the operator is the creation actor.
  const opGuest = await placeOffline(product.id, "cod", `${TAG}-op-guest`, { actorUserId: null, operatorUserId: OPERATOR });
  check("operator/guest: order placed", opGuest.ok === true);
  if (opGuest.ok) {
    const a = await creationAudit(opGuest.data.orderId);
    check("operator/guest: « Commande créée » actor = operator", a.historyActor === OPERATOR);
    check("operator/guest: history note flags the operator entry", a.notes === "Commande créée (saisie opérateur)");
    check("operator/guest: stock movement actor = operator", a.movementActors.length > 0 && a.movementActors.every((x) => x === OPERATOR));
    check("operator/guest: still a guest order (user_id null)", a.userId === null);
  }

  // Customer-attributed order created by an operator: user_id = customer, actor = operator.
  const opCust = await placeOffline(product.id, "cod", `${TAG}-op-cust`, { actorUserId: CUSTOMER, operatorUserId: OPERATOR });
  check("operator/customer: order placed", opCust.ok === true);
  if (opCust.ok) {
    const a = await creationAudit(opCust.data.orderId);
    check("operator/customer: user_id = customer", a.userId === CUSTOMER);
    check("operator/customer: « Commande créée » actor = operator (not the customer)", a.historyActor === OPERATOR);
  }

  // Self-checkout (no operator): the customer stays the actor, note unchanged.
  const self = await placeOffline(product.id, "cod", `${TAG}-self`, { actorUserId: CUSTOMER });
  check("self-checkout: order placed", self.ok === true);
  if (self.ok) {
    const a = await creationAudit(self.data.orderId);
    check("self-checkout: actor = customer", a.historyActor === CUSTOMER);
    check("self-checkout: note unchanged", a.notes === "Commande créée");
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
