import "server-only";

/**
 * Order-placement hardening regressions (A–Z 2026-09-23, phase 1):
 *
 *   1. IDEMPOTENCY — two concurrent placements of the SAME cart create exactly ONE
 *      order (the cart row is locked + its lines claimed with DELETE … RETURNING
 *      inside the tx); a sequential retry after success is refused; a line changed
 *      by another tab mid-placement aborts cleanly and the cart is left intact.
 *   2. DELIVERY — an in-store sale with no pickup point (the caisse) stays
 *      `in_store` at fee 0 and never auto-saves its placeholder address — even
 *      with the storefront « Retrait en magasin » toggle off; a disabled method
 *      is refused (`delivery_unavailable`), never re-routed — for a STOREFRONT
 *      order only: an operator placement (manual order / caisse / ERP push)
 *      skips the storefront toggles but its pickup point is still validated.
 *   3. SWEEP — the abandoned-order sweep never cancels an operator-confirmed COD
 *      order, an ERP-pushed order, or a point-less offline counter sale (caisse
 *      « Non payé »); an unconfirmed abandoned order IS cancelled — including a
 *      shopper's pickup + COD order naming a pickup point.
 *   4. ABUSE GUARDS — the storefront order throttle (per IP, + per phone / email
 *      counting only PLACED orders, so refused attempts carrying a victim's
 *      number never lock it) and the contact-email fallback to the signed-in
 *      account; over-long free text is refused with a readable message.
 *
 * NOTE: step 3 runs the real sweep, which cancels EVERY stale pending order in
 * the target DB — run it only against a throwaway test DB. Self-cleaning
 * (`__opgtest…`). Run:
 *   DATABASE_URL=… pnpm exec tsx --conditions=react-server \
 *     src/lib/db/tests/order-placement-guards.test.ts
 */
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { carts, cart_items } from "@/modules/cart/schema";
import { orders } from "@/modules/order/schema";
import { orderService } from "@/modules/order/service";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { deliveryService } from "@/modules/delivery/service";
import { workflows } from "@/workflows";
import { resolveDelivery } from "@/lib/checkout/delivery";
import { peekRateLimit } from "@/lib/rate-limit";
import {
  checkOrderPlacementRateLimit,
  orderPhoneKey,
  ORDER_RATE_LIMITS,
  recordOrderPlaced,
  resolveOrderContactEmail,
} from "@/lib/checkout/place-order-guards";

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

const TAG = "__opgtest";
const U = `${TAG}-u1`;
/** Rate-limit bucket keys this run created (phone keys carry no TAG). */
const bucketKeys: string[] = [];
const DELIVERY_KEYS = ["delivery.home_enabled", "delivery.in_store_enabled"];

async function cleanup() {
  const mine = sql`(select id from orders where contact_phone = ${TAG})`;
  await db.execute(sql`delete from stock_movements where order_id in ${mine}`);
  await db.execute(sql`delete from order_status_history where order_id in ${mine}`);
  await db.execute(sql`delete from order_items where order_id in ${mine}`);
  await db.execute(sql`delete from orders where contact_phone = ${TAG}`);
  await db.execute(sql`delete from cart_items where cart_id in (select id from carts where token like ${TAG + "%"})`);
  await db.execute(sql`delete from carts where token like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from pickup_locations where name like ${TAG + "%"}`);
  await db.execute(
    sql`delete from addresses where customer_profile_id in (select customer_profile_id from customer_user_links where user_id like ${TAG + "%"})`,
  );
  const profiles = await db.execute<{ id: string }>(
    sql`select customer_profile_id as id from customer_user_links where user_id like ${TAG + "%"}`,
  );
  await db.execute(sql`delete from customer_user_links where user_id like ${TAG + "%"}`);
  for (const p of profiles.rows) {
    await db.execute(sql`delete from customer_profiles where id = ${p.id}`);
  }
  await db.execute(sql`delete from users where id like ${TAG + "%"}`);
  for (const k of bucketKeys) {
    await db.execute(sql`delete from rate_limit_buckets where bucket_key = ${k}`);
  }
}

async function readSettings(): Promise<Map<string, string | null>> {
  const rows = await db.execute<{ key: string; value: string | null }>(
    sql`select key, value from site_settings where key in ('delivery.home_enabled', 'delivery.in_store_enabled')`,
  );
  return new Map(rows.rows.map((r) => [r.key, r.value]));
}
async function setBool(key: string, on: boolean) {
  await db.execute(
    sql`insert into site_settings (key, value, type, label) values (${key}, ${on ? "true" : "false"}, 'boolean', 'test')
        on conflict (key) do update set value = ${on ? "true" : "false"}`,
  );
}
async function restoreSettings(saved: Map<string, string | null>) {
  for (const key of DELIVERY_KEYS) {
    if (saved.has(key)) {
      await db.execute(sql`update site_settings set value = ${saved.get(key) ?? null} where key = ${key}`);
    } else {
      await db.execute(sql`delete from site_settings where key = ${key}`);
    }
  }
}

async function mkCart(token: string, productId: string, quantity: number): Promise<string> {
  const [cart] = await db.insert(carts).values({ token } as never).returning({ id: carts.id });
  await db.insert(cart_items).values({
    cart_id: cart.id,
    product_id: productId,
    variant_id: "",
    quantity,
    unit_price_cents: 50000,
  } as never);
  return cart.id;
}

function place(
  cartId: string,
  opts: {
    method?: "home_delivery" | "in_store";
    actorUserId?: string | null;
    /** Staff placing it (manual order / caisse) → operator delivery channel. */
    operatorUserId?: string | null;
    /** ERP push: operator channel without an operator user. */
    deliveryChannel?: "storefront" | "operator";
    street?: string;
    notes?: string;
  } = {},
) {
  return workflows.order.place(
    {
      cartId,
      contactEmail: "",
      contactPhone: TAG,
      shipping: {
        fullName: "OPG Test",
        streetLine1: opts.street ?? "Vente en boutique",
        city: "Boutique",
        country: "TN",
      },
      deliveryMethod: opts.method ?? "home_delivery",
      paymentMethod: "cod",
      notes: opts.notes,
    },
    {
      actorUserId: opts.actorUserId ?? null,
      operatorUserId: opts.operatorUserId,
      deliveryChannel: opts.deliveryChannel,
    },
  );
}

async function stockOf(productId: string): Promise<number | null> {
  const [row] = await db.select({ s: products.stock_qty }).from(products).where(eq(products.id, productId));
  return row?.s ?? null;
}
async function cartLineQty(cartId: string): Promise<number[]> {
  const rows = await db.select({ q: cart_items.quantity }).from(cart_items).where(eq(cart_items.cart_id, cartId));
  return rows.map((r) => r.q);
}

/** Wait until some backend is blocked on a row lock of `carts` (bounded). */
async function waitForCartLockWaiter(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and query ilike '%"carts"%for update%'
    `);
    if (Number(r.rows[0]?.n ?? 0) > 0) return true;
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}

async function main() {
  await cleanup();
  const savedSettings = await readSettings();

  try {
    // Home + in-store ON for the placement sections (restored at the end).
    for (const key of DELIVERY_KEYS) await setBool(key, true);

    const [product] = await db
      .insert(products)
      .values({ slug: `${TAG}-prod`, name: `${TAG} Montre`, price_cents: 50000, stock_qty: 10, in_stock: true, is_published: true } as never)
      .returning({ id: products.id });

    // ── 1. Idempotency ─────────────────────────────────────────────────────
    console.log("idempotency");
    const cartA = await mkCart(`${TAG}-a`, product.id, 2);
    const [r1, r2] = await Promise.all([place(cartA), place(cartA)]);
    const oks = [r1, r2].filter((r) => r.ok).length;
    const loser = [r1, r2].find((r) => !r.ok);
    check("concurrent double-submit → exactly ONE order", oks === 1);
    check(
      "the other submit is refused (conflict / empty cart)",
      !!loser && !loser.ok && (loser.error === "conflict" || loser.error === "empty_cart"),
    );
    check("stock decremented ONCE (10 → 8)", (await stockOf(product.id)) === 8);
    const [{ n: ordersSoFar }] = (
      await db.execute<{ n: number }>(sql`select count(*)::int as n from orders where contact_phone = ${TAG}`)
    ).rows;
    check("exactly one order row written", Number(ordersSoFar) === 1);
    const retry = await place(cartA);
    check("sequential retry after success → refused (empty cart)", !retry.ok && retry.error === "empty_cart");

    // A line changed by another tab AFTER the priced read but BEFORE the claim.
    const cartB = await mkCart(`${TAG}-b`, product.id, 1);
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let lockHeld!: () => void;
    const held = new Promise<void>((res) => (lockHeld = res));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`select id from carts where id = ${cartB} for update`);
      lockHeld();
      await gate;
      await tx.execute(sql`update cart_items set quantity = 3 where cart_id = ${cartB}`);
    });
    await held;
    const placing = place(cartB);
    const waited = await waitForCartLockWaiter();
    check("placement blocks on the cart row lock (serialized)", waited);
    release();
    await holder;
    const changed = await placing;
    check(
      "changed cart mid-placement → refused (conflict « modifié »)",
      !changed.ok && changed.error === "conflict" && /modifi/i.test(changed.message),
    );
    check("…and rolled back: stock untouched (still 8)", (await stockOf(product.id)) === 8);
    const bLines = await cartLineQty(cartB);
    check("…and the cart line is NOT dropped (qty 3 kept)", bLines.length === 1 && bLines[0] === 3);

    // ── 2. Delivery (caisse in-store, disabled method) ───────────────────────
    console.log("delivery");
    await authService.insert({ id: U, email: `${U}@example.test`, name: U, role: "customer" } as never);
    const profile = await customerService.insertProfile({ first_name: "Opg", last_name: "Test" } as never);
    await customerUserLink.create({ customer_profile_id: profile.id, user_id: U } as never);

    const cartC = await mkCart(`${TAG}-c`, product.id, 1);
    const counter = await place(cartC, { method: "in_store", actorUserId: U });
    check("in-store sale without a pickup point → placed", counter.ok);
    if (counter.ok) {
      const [o] = await db.select().from(orders).where(eq(orders.id, counter.data.orderId));
      check("…stored as in_store (not home_delivery)", o.delivery_method === "in_store");
      check("…with NO delivery fee", o.shipping_cents === 0);
      check("…and no pickup snapshot", o.pickup_location_id === null);
    }
    check(
      "…placeholder « Vente en boutique » NOT saved to the address book",
      (await customerService.listAddressesByProfile(profile.id)).length === 0,
    );

    // Positive control: a real home delivery still auto-saves the address.
    const cartD = await mkCart(`${TAG}-d`, product.id, 1);
    const home = await place(cartD, { method: "home_delivery", actorUserId: U, street: "12 rue du Test" });
    check("home delivery → placed", home.ok);
    check(
      "…and its address IS auto-saved (1 address)",
      (await customerService.listAddressesByProfile(profile.id)).length === 1,
    );

    // Home delivery disabled → refused, never silently re-routed.
    await setBool("delivery.home_enabled", false);
    const cartE = await mkCart(`${TAG}-e`, product.id, 1);
    const stockBefore = await stockOf(product.id);
    const refused = await place(cartE);
    check(
      "home disabled + home_delivery → refused (delivery_unavailable)",
      !refused.ok && refused.error === "delivery_unavailable",
    );
    check("…no stock taken", (await stockOf(product.id)) === stockBefore);
    check("…cart kept", (await cartLineQty(cartE)).length === 1);

    // …but the toggle is a STOREFRONT setting: a pickup-only e-shop still ships
    // the phone / VIP orders an operator types in and the ERP pushes.
    const cartOp = await mkCart(`${TAG}-op`, product.id, 1);
    const opHome = await place(cartOp, { operatorUserId: U });
    check("home disabled + OPERATOR placement (manual order / caisse) → placed", opHome.ok);
    if (opHome.ok) {
      const [o] = await db.select().from(orders).where(eq(orders.id, opHome.data.orderId));
      check("…as home_delivery (not re-routed)", o.delivery_method === "home_delivery");
    }
    const cartErp = await mkCart(`${TAG}-erp`, product.id, 1);
    const erpHome = await place(cartErp, { deliveryChannel: "operator" });
    check("home disabled + ERP push (operator channel, no operator user) → placed", erpHome.ok);
    const opResolved = await resolveDelivery({
      method: "home_delivery",
      subtotalCents: 50_000,
      channel: "operator",
    });
    const sfResolved = await resolveDelivery({ method: "home_delivery", subtotalCents: 50_000 });
    check(
      "resolveDelivery: home disabled → storefront refused, operator gets the home base",
      !sfResolved.ok && sfResolved.reason === "method_disabled" &&
        opResolved.ok && opResolved.deliveryMethod === "home_delivery",
    );
    await setBool("delivery.home_enabled", true);

    // Storefront « Retrait en magasin » toggle OFF → the till (a point-less
    // in_store counter sale, no delivery picker) must still record the sale.
    await setBool("delivery.in_store_enabled", false);
    const cartT = await mkCart(`${TAG}-t`, product.id, 1);
    const till = await place(cartT, { method: "in_store" });
    check("in-store toggle OFF + caisse sale (no point) → still placed", till.ok);
    if (till.ok) {
      const [o] = await db.select().from(orders).where(eq(orders.id, till.data.orderId));
      check("…as in_store with no fee", o.delivery_method === "in_store" && o.shipping_cents === 0);
    }

    // Same toggle OFF with an explicit pickup POINT: a shopper is refused, an
    // operator may still use the point — but the point row itself is validated
    // on every channel (enabled, matching kind).
    const point = await deliveryService.insertPickup({
      name: `${TAG}-point`,
      kind: "in_store",
      fee_cents: 3000,
      enabled: true,
    } as never);
    const pointOff = await deliveryService.insertPickup({
      name: `${TAG}-point-off`,
      kind: "in_store",
      fee_cents: 0,
      enabled: false,
    } as never);
    const sfPoint = await resolveDelivery({ method: "in_store", pickupLocationId: point.id, subtotalCents: 50_000 });
    check(
      "in-store toggle OFF + storefront point → refused (method_disabled)",
      !sfPoint.ok && sfPoint.reason === "method_disabled",
    );
    const opPoint = await resolveDelivery({
      method: "in_store",
      pickupLocationId: point.id,
      subtotalCents: 50_000,
      channel: "operator",
    });
    check(
      "…operator channel → the point with its fee + name snapshot",
      opPoint.ok && opPoint.deliveryMethod === "in_store" && opPoint.shippingCents === 3000 &&
        opPoint.pickupLocationName === `${TAG}-point`,
    );
    const opPointOff = await resolveDelivery({
      method: "in_store",
      pickupLocationId: pointOff.id,
      subtotalCents: 50_000,
      channel: "operator",
    });
    check(
      "…operator channel still refuses a DISABLED point",
      !opPointOff.ok && opPointOff.reason === "pickup_unavailable",
    );
    const opWrongKind = await resolveDelivery({
      method: "drive_by_pickup",
      pickupLocationId: point.id,
      subtotalCents: 50_000,
      channel: "operator",
    });
    check(
      "…and a point of the wrong kind",
      !opWrongKind.ok && opWrongKind.reason === "pickup_unavailable",
    );
    await setBool("delivery.in_store_enabled", true);

    // Over-long free text → refused with a readable message.
    const cartF = await mkCart(`${TAG}-f`, product.id, 1);
    const tooLong = await place(cartF, { notes: "x".repeat(1001) });
    check(
      "notes > 1000 chars → validation refusal naming the length cap",
      !tooLong.ok && tooLong.error === "validation" && /trop long/i.test(tooLong.message),
    );

    // ── 3. Abandoned-order sweep ─────────────────────────────────────────────
    console.log("sweep");
    const mk = async (
      n: string,
      extra: {
        payment_method: string;
        delivery_method: string;
        confirmed_at?: Date;
        paid_at?: Date;
        external_ref?: string;
        pickup_location_name?: string;
      },
    ) => {
      const o = await orderService.insertOrder({
        order_number: `${TAG}-sw-${n}`,
        contact_email: "",
        contact_phone: TAG,
        status: "pending",
        subtotal_cents: 50_000,
        total_cents: 50_000,
        ship_full_name: "T",
        ship_street_line1: "1",
        ship_city: "Tunis",
        ...extra,
      } as never);
      // Far in the past so the sweep's oldest-first batch always reaches them.
      await db.execute(sql`update orders set updated_at = now() - interval '3650 days' where id = ${o.id}`);
      return o.id;
    };
    const codUnconfirmed = await mk("cod-unconf", { payment_method: "cod", delivery_method: "home_delivery" });
    const codConfirmed = await mk("cod-conf", {
      payment_method: "cod",
      delivery_method: "home_delivery",
      confirmed_at: new Date(),
    });
    const caisseUnpaid = await mk("caisse", { payment_method: "cod", delivery_method: "in_store" });
    const erpPushed = await mk("erp", {
      payment_method: "cod",
      delivery_method: "home_delivery",
      external_ref: `${TAG}-erp-${Date.now()}`,
    });
    const onlinePickup = await mk("online-pickup", { payment_method: "clictopay", delivery_method: "in_store" });
    // A shopper's « Drive » / « Retrait en magasin » order paid COD names its
    // point (frozen name snapshot — the point id is SET NULL if it's deleted).
    const pickupCod = await mk("pickup-cod", {
      payment_method: "cod",
      delivery_method: "drive_by_pickup",
      pickup_location_name: `${TAG} Drive Lac`,
    });
    const inStorePointCod = await mk("instore-point-cod", {
      payment_method: "cod",
      delivery_method: "in_store",
      pickup_location_name: `${TAG} Boutique`,
    });
    // An operator hand-marked this COD order paid (paid_at set) but has not yet
    // advanced it to « En préparation » — it must NOT be auto-cancelled/restocked.
    const codPaid = await mk("cod-paid", {
      payment_method: "cod",
      delivery_method: "home_delivery",
      paid_at: new Date(),
    });

    const candidates = new Set((await orderService.listAbandonedPending(48, 1000)).map((o) => o.id));
    check("unconfirmed COD home order is a sweep candidate", candidates.has(codUnconfirmed));
    check("abandoned ONLINE pickup order is a sweep candidate", candidates.has(onlinePickup));
    check("storefront drive-by + COD (named point) IS a sweep candidate", candidates.has(pickupCod));
    check("storefront in-store + COD (named point) IS a sweep candidate", candidates.has(inStorePointCod));
    check("operator-CONFIRMED COD order is NOT a candidate", !candidates.has(codConfirmed));
    check("caisse « Non payé » (in_store COD) is NOT a candidate", !candidates.has(caisseUnpaid));
    check("ERP-pushed order (external_ref) is NOT a candidate", !candidates.has(erpPushed));
    check("hand-marked-PAID COD order is NOT a candidate", !candidates.has(codPaid));

    const swept = await workflows.order.sweepAbandonedOrders({}, { actorUserId: null });
    check("sweep ran", swept.ok);
    const statusOf = async (id: string) =>
      (await db.select({ s: orders.status }).from(orders).where(eq(orders.id, id)))[0]?.s;
    check("…unconfirmed COD → cancelled", (await statusOf(codUnconfirmed)) === "cancelled");
    check("…online pickup (no gateway ref) → cancelled", (await statusOf(onlinePickup)) === "cancelled");
    check("…storefront pickup + COD → cancelled (stock released)", (await statusOf(pickupCod)) === "cancelled");
    check("…confirmed COD survives (pending)", (await statusOf(codConfirmed)) === "pending");
    check("…caisse non payé survives (pending)", (await statusOf(caisseUnpaid)) === "pending");
    check("…ERP order survives (pending)", (await statusOf(erpPushed)) === "pending");
    check("…hand-marked-paid COD survives (pending)", (await statusOf(codPaid)) === "pending");

    // ── 4. Abuse guards ──────────────────────────────────────────────────────
    console.log("abuse guards");
    const rand = Math.floor(Math.random() * 1e7).toString().padStart(7, "0");
    const ip = `${TAG}-ip-${rand}`;
    bucketKeys.push(`order:ip:${ip}`);
    const ipResults: boolean[] = [];
    for (let i = 0; i < ORDER_RATE_LIMITS.ip.max + 1; i++) {
      ipResults.push(await checkOrderPlacementRateLimit({ ip }));
    }
    check(
      `per-IP: first ${ORDER_RATE_LIMITS.ip.max} allowed, next refused`,
      ipResults.slice(0, -1).every(Boolean) && ipResults[ipResults.length - 1] === false,
    );

    // A tripped IP is refused BEFORE the phone/email buckets are even looked at,
    // so a blocked script can't burn anybody's slot either.
    const victim = `8${rand}`; // 8 digits
    bucketKeys.push(`order:phone:${victim}`);
    const blockedIp = await checkOrderPlacementRateLimit({ ip, phone: victim });
    check("tripped IP → still refused", blockedIp === false);
    check(
      "…and the victim's phone bucket was not touched",
      (await peekRateLimit({ bucket: `order:phone:${victim}`, max: ORDER_RATE_LIMITS.phone.max })).count === 0,
    );

    // A third party replaying refused / order-less attempts under a victim's
    // number (each pre-workflow check only PEEKS the phone bucket) can't lock it.
    const attempts: boolean[] = [];
    for (let i = 0; i < ORDER_RATE_LIMITS.phone.max * 3; i++) {
      attempts.push(await checkOrderPlacementRateLimit({ ip: null, phone: `+216 ${victim}` }));
    }
    check(
      `per-phone: ${ORDER_RATE_LIMITS.phone.max * 3} attempts that placed no order → all allowed`,
      attempts.every(Boolean),
    );
    check(
      "…and the victim can still order (bucket never incremented)",
      (await checkOrderPlacementRateLimit({ ip: null, phone: victim })) === true &&
        (await peekRateLimit({ bucket: `order:phone:${victim}`, max: ORDER_RATE_LIMITS.phone.max })).count === 0,
    );

    // PLACED orders still count: after `max` of them the contact is refused.
    const local = `9${rand}`; // 8 digits
    bucketKeys.push(`order:phone:${local}`);
    const phoneResults: boolean[] = [];
    for (let i = 0; i < ORDER_RATE_LIMITS.phone.max; i++) {
      phoneResults.push(await checkOrderPlacementRateLimit({ ip: null, phone: local }));
      await recordOrderPlaced({ phone: local });
    }
    check(`per-phone: first ${ORDER_RATE_LIMITS.phone.max} placed orders allowed`, phoneResults.every(Boolean));
    check(
      `per-phone: order #${ORDER_RATE_LIMITS.phone.max + 1} refused — +216 / 00216 formats share the bucket`,
      (await checkOrderPlacementRateLimit({ ip: null, phone: local })) === false &&
        (await checkOrderPlacementRateLimit({ ip: null, phone: `+216 ${local.slice(0, 2)} ${local.slice(2)}` })) === false &&
        (await checkOrderPlacementRateLimit({ ip: null, phone: `00216${local}` })) === false,
    );
    check(
      "…the refused checks did not push the count past the placed orders",
      (await peekRateLimit({ bucket: `order:phone:${local}`, max: ORDER_RATE_LIMITS.phone.max })).count ===
        ORDER_RATE_LIMITS.phone.max,
    );

    const email = `${TAG}-${rand}@example.test`;
    bucketKeys.push(`order:email:${email}`);
    for (let i = 0; i < ORDER_RATE_LIMITS.email.max; i++) {
      await recordOrderPlaced({ email: i % 2 === 0 ? email : `  ${email.toUpperCase()} ` });
    }
    check(
      `per-email: ${ORDER_RATE_LIMITS.email.max} placed orders (case / spaces folded) → next refused`,
      (await checkOrderPlacementRateLimit({ ip: null, email })) === false,
    );

    // An EXPIRED bucket reads as empty (the window is over).
    const stale = `order:phone:${TAG}-stale-${rand}`;
    bucketKeys.push(stale);
    await db.execute(
      sql`insert into rate_limit_buckets (bucket_key, count, expires_at, first_seen)
          values (${stale}, 99, now() - interval '1 minute', now() - interval '20 minutes')`,
    );
    const stalePeek = await peekRateLimit({ bucket: stale, max: ORDER_RATE_LIMITS.phone.max });
    check("peekRateLimit: an expired bucket reads 0 → allowed", stalePeek.ok && stalePeek.count === 0);
    check(
      "unknown IP + no phone/email → never throttled (no shared anon bucket)",
      (await checkOrderPlacementRateLimit({ ip: null })) === true,
    );
    check("orderPhoneKey strips +216 / spaces", orderPhoneKey("+216 12 345 678") === "12345678");
    check("orderPhoneKey: no digits → null", orderPhoneKey("abc") === null);

    check(
      "contact email: blank → signed-in account email",
      resolveOrderContactEmail({ submitted: "  ", sessionEmail: "a@b.tn" }) === "a@b.tn",
    );
    check(
      "contact email: a typed address wins",
      resolveOrderContactEmail({ submitted: " x@y.tn ", sessionEmail: "a@b.tn" }) === "x@y.tn",
    );
    check(
      "contact email: field hidden → submitted value ignored",
      resolveOrderContactEmail({ submitted: "victim@z.tn", sessionEmail: null, acceptSubmitted: false }) === "",
    );
    check(
      "contact email: field hidden + signed in → account email",
      resolveOrderContactEmail({ submitted: "victim@z.tn", sessionEmail: "a@b.tn", acceptSubmitted: false }) === "a@b.tn",
    );
  } finally {
    await restoreSettings(savedSettings);
    await cleanup();
  }

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
