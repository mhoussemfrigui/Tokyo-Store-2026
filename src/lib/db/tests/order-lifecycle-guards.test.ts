import "server-only";

/**
 * Order lifecycle guards (A–Z 09-23, orders-06/07/09). Exercises the real
 * workflows against inserted orders:
 *   PAY  — the payment METHOD is locked once the order left `pending` UNSETTLED
 *          (a shipped COD order can't be switched to cash, which would strand
 *          `paid_at` at delivery); re-sending the current method / a
 *          reference-only update still works; a pending order and an already
 *          settled one (paid cash → virement) can still switch.
 *   BL   — a parcel-fulfilled order (Shipments panel / ERP) gets NO second,
 *          whole-order bon de livraison from the issue-on-ship subscriber; a
 *          dropdown-shipped order (no parcel) still gets its auto BL.
 *   GATE — cancelling a PENDING online order runs the fail-closed gateway
 *          pre-flight inside the workflow itself (so the external status API
 *          can't bypass it): an unverifiable payment refuses the cancel (503
 *          on the API, not 500); a pending COD order still cancels + restocks.
 *   LEDGER — receiving a return on a SHARED-pool variant line restocks the
 *          parent pool AND ledgers it product-level (variant_id null), like the
 *          sale; a per-variant-stock line keeps its variant_id.
 * Self-cleaning (`__lcguard…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/order-lifecycle-guards.test.ts
 */
import { eq, sql } from "drizzle-orm";

import { registerIssueBlOnShipSubscriber } from "@/events/subscribers/issue-bl-on-ship";
import { db } from "@/lib/db/client";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { orders, order_items } from "@/modules/order/schema";
import { orderService } from "@/modules/order/service";
import { workflowErrorStatus } from "@/lib/api-auth/enforce";
import { ensureOrderDeliveryNoteNumber } from "@/lib/order/issue-delivery-note";
import { resolvePaymentConfig } from "@/lib/payments/config";
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

const TAG = "__lcguard";
const ACTOR = "__lcguard-actor";

async function stockOf(productId: string): Promise<number | null> {
  const [r] = await db.select({ s: products.stock_qty }).from(products).where(eq(products.id, productId));
  return r?.s ?? null;
}

async function cleanup() {
  const mine = sql`(select id from orders where order_number like ${TAG + "%"})`;
  await db.execute(sql`delete from order_return_items where return_id in (select id from order_returns where order_id in ${mine})`);
  await db.execute(sql`delete from order_returns where order_id in ${mine}`);
  await db.execute(sql`delete from shipment_items where shipment_id in (select id from shipments where order_id in ${mine})`);
  await db.execute(sql`delete from shipments where order_id in ${mine}`);
  await db.execute(sql`delete from stock_movements where order_id in ${mine}`);
  await db.execute(sql`delete from order_refunds where order_id in ${mine}`);
  await db.execute(sql`delete from order_status_history where order_id in ${mine}`);
  await db.execute(sql`delete from order_items where order_id in ${mine}`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
  await db.execute(sql`delete from product_variants where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

async function mkProduct(slug: string, stock: number) {
  const [p] = await db
    .insert(products)
    .values({ slug: `${TAG}-${slug}`, name: `${TAG} ${slug}`, price_cents: 10_000, stock_qty: stock, in_stock: true, is_published: true } as never)
    .returning({ id: products.id });
  return p.id;
}

async function mkOrder(tag: string, status: string, paymentMethod: string, extra: Record<string, unknown> = {}) {
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-${tag}-${Date.now()}`,
      contact_email: "lc@example.com",
      status,
      payment_method: paymentMethod,
      subtotal_cents: 10_000,
      total_cents: 10_000,
      ship_full_name: "LC",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
      ...extra,
    } as never)
    .returning({ id: orders.id });
  return o.id;
}

async function mkVariant(productId: string, sku: string, stock: number) {
  const [v] = await db
    .insert(product_variants)
    .values({ product_id: productId, sku: `${TAG}-${sku}`, label: sku, price_cents: 10_000, stock_qty: stock, in_stock: true } as never)
    .returning({ id: product_variants.id });
  return v.id;
}

async function variantStockOf(variantId: string): Promise<number | null> {
  const [r] = await db.select({ s: product_variants.stock_qty }).from(product_variants).where(eq(product_variants.id, variantId));
  return r?.s ?? null;
}

async function returnLedger(orderId: string): Promise<Array<{ variant_id: string | null; delta: number }>> {
  const r = await db.execute(sql`select variant_id, delta from stock_movements where order_id = ${orderId} and reason = 'return'`);
  return r.rows as Array<{ variant_id: string | null; delta: number }>;
}

async function mkItem(orderId: string, productId: string, qty: number, variantId: string | null = null) {
  const [it] = await db
    .insert(order_items)
    .values({
      order_id: orderId,
      product_id: productId,
      variant_id: variantId,
      product_name: `${TAG} line`,
      product_slug: `${TAG}-line`,
      unit_price_cents: 10_000,
      quantity: qty,
      subtotal_cents: 10_000 * qty,
    } as never)
    .returning({ id: order_items.id });
  return it.id;
}

async function main() {
  // The BL checks need the issue-on-ship subscriber. Register only that one —
  // unless the import graph already ran registerAllSubscribers() (`@/workflows`
  // pulls in lib/auth/server, which side-effect-imports the full set, as in every
  // workflow-level suite), in which case it's live already and a second copy
  // would fire twice.
  if (!globalThis.__gz_subscribers_registered) registerIssueBlOnShipSubscriber();
  await cleanup();

  // ── PAY: payment-method lock after fulfilment ─────────────────────────────
  {
    const p = await mkProduct("pay", 5);
    const o = await mkOrder("pay-shipped", "shipped", "cod");
    await mkItem(o, p, 1);

    const sw = await workflows.order.setPaymentReference({ orderId: o, paymentMethod: "cash", paymentReference: "REC-1" }, { actorUserId: ACTOR });
    check("pay: switching a SHIPPED COD order to cash is refused", sw.ok === false && sw.error === "conflict");
    const afterSw = await orderService.findById(o);
    check("pay: refused switch left method + reference untouched", afterSw?.payment_method === "cod" && afterSw?.payment_reference == null);

    const same = await workflows.order.setPaymentReference({ orderId: o, paymentMethod: "cod", paymentReference: "REC-2" }, { actorUserId: ACTOR });
    check("pay: re-sending the CURRENT method (reference fix) is allowed", same.ok === true);
    const refOnly = await workflows.order.setPaymentReference({ orderId: o, paymentMethod: null, paymentReference: "REC-3" }, { actorUserId: ACTOR });
    check("pay: reference-only update is allowed", refOnly.ok === true && (await orderService.findById(o))?.payment_reference === "REC-3");

    // The whole point: the order stays COD, so delivery settles it (paid_at).
    const deliver = await workflows.order.transitionStatus({ orderId: o, toStatus: "delivered" }, { actorUserId: null });
    check("pay: COD delivery still stamps paid_at (not stranded)", deliver.ok === true && (await orderService.findById(o))?.paid_at != null);

    const pending = await mkOrder("pay-pending", "pending", "cod");
    await mkItem(pending, p, 1);
    const swPending = await workflows.order.setPaymentReference({ orderId: pending, paymentMethod: "bank_transfer", paymentReference: "VIR-1" }, { actorUserId: ACTOR });
    check("pay: a PENDING unpaid order can still switch method", swPending.ok === true && (await orderService.findById(pending))?.payment_method === "bank_transfer");

    // Already SETTLED (paid_at stamped): correcting the recorded method is safe —
    // paid_at is never re-stamped and the graphs match past `pending`.
    const settled = await mkOrder("pay-settled", "paid", "cash", { paid_at: new Date() });
    await mkItem(settled, p, 1);
    const swSettled = await workflows.order.setPaymentReference({ orderId: settled, paymentMethod: "bank_transfer", paymentReference: "VIR-2" }, { actorUserId: ACTOR });
    const afterSettled = await orderService.findById(settled);
    check("pay: a PAID (settled) cash order can switch to bank_transfer", swSettled.ok === true && afterSettled?.payment_method === "bank_transfer" && afterSettled?.paid_at != null);
  }

  // ── BL: no second whole-order BL on a parcel-fulfilled order ──────────────
  {
    const p = await mkProduct("bl", 5);
    const o = await mkOrder("bl-parcel", "preparing", "cod");
    const line = await mkItem(o, p, 1);
    const ship = await workflows.order.createShipment({ orderId: o, lines: [{ orderItemId: line, quantity: 1 }], markShipped: true }, { actorUserId: null });
    check("bl: full parcel shipment ok + order shipped", ship.ok === true && (await orderService.findById(o))?.status === "shipped");
    check("bl: the parcel carries its BL number", ship.ok === true && /^[A-Z0-9]+-\d{4}-\d{6}$/.test(ship.data.deliveryNoteNumber));
    check("bl: issue-on-ship did NOT stamp a second, whole-order BL", (await orderService.findById(o))?.delivery_note_number == null);
    const direct = await ensureOrderDeliveryNoteNumber(o, undefined, { skipIfShipments: true });
    check("bl: ensureOrderDeliveryNoteNumber(skipIfShipments) skips a parcel order", direct === null);

    // Dropdown fulfilment (no parcel) still gets its automatic BL.
    const o2 = await mkOrder("bl-dropdown", "preparing", "cod");
    await mkItem(o2, p, 1);
    const t = await workflows.order.transitionStatus({ orderId: o2, toStatus: "shipped" }, { actorUserId: null });
    check("bl: dropdown ship (no parcel) ok", t.ok === true);
    check("bl: dropdown-shipped order gets its auto whole-order BL", (await orderService.findById(o2))?.delivery_note_number != null);
  }

  // ── GATE: pending online cancel runs the gateway pre-flight in the workflow ──
  {
    const flouci = await resolvePaymentConfig("flouci");
    if (flouci.appToken && flouci.appSecret) {
      console.log("  – gate: Flouci is configured on this DB — unverifiable-payment case skipped");
    } else {
      const p = await mkProduct("gate", 5);
      const o = await mkOrder("gate-online", "pending", "flouci", { payment_reference: `${TAG}-ref` });
      await mkItem(o, p, 1);
      const c = await workflows.order.transitionStatus({ orderId: o, toStatus: "cancelled" }, { actorUserId: null });
      check("gate: unverifiable pending online order is NOT cancelled (fail-closed)", c.ok === false && c.error === "payment_unverified");
      check("gate: order still pending, stock untouched", (await orderService.findById(o))?.status === "pending" && (await stockOf(p)) === 5);
    }
    // The external status API maps the workflow codes: an unreachable gateway is
    // a retryable 503, graph / refund-ledger refusals are 409s — never a 500.
    check("gate: payment_unverified → 503 on the API", workflowErrorStatus("payment_unverified") === 503);
    check("gate: invalid_transition / refund_required → 409", workflowErrorStatus("invalid_transition") === 409 && workflowErrorStatus("refund_required") === 409);

    const pc = await mkProduct("gate-cod", 5);
    const cod = await mkOrder("gate-cod", "pending", "cod");
    await mkItem(cod, pc, 2);
    const cc = await workflows.order.transitionStatus({ orderId: cod, toStatus: "cancelled" }, { actorUserId: null });
    check("gate: pending COD order still cancels (no gateway to verify)", cc.ok === true);
    check("gate: COD cancel restocked 5→7", (await stockOf(pc)) === 7);
  }

  // ── LEDGER: shared-pool return is ledgered product-level ────────────────────
  {
    const shared = await mkProduct("ledger-shared", 5);
    await db.update(products).set({ shared_variant_stock: true } as never).where(eq(products.id, shared));
    const sv = await mkVariant(shared, "ledger-sv", 3);
    const o = await mkOrder("ledger-shared", "delivered", "cod");
    const line = await mkItem(o, shared, 1, sv);
    const ret = await workflows.order.createReturn({ orderId: o, lines: [{ orderItemId: line, quantity: 1, restockable: true }] }, { actorUserId: null });
    check("ledger: shared-pool return created", ret.ok === true);
    if (ret.ok) {
      const recv = await workflows.order.receiveReturn({ returnId: ret.data.returnId }, { actorUserId: null });
      check("ledger: shared return restocks the PARENT pool 5→6 (variant row untouched)", recv.ok === true && (await stockOf(shared)) === 6 && (await variantStockOf(sv)) === 3);
      const rows = await returnLedger(o);
      check("ledger: shared return ledgered product-level (variant_id null)", rows.length === 1 && rows[0].variant_id === null && Number(rows[0].delta) === 1);
    }

    const own = await mkProduct("ledger-own", 5);
    await db.update(products).set({ shared_variant_stock: false } as never).where(eq(products.id, own));
    const ov = await mkVariant(own, "ledger-ov", 3);
    const o2 = await mkOrder("ledger-own", "delivered", "cod");
    const line2 = await mkItem(o2, own, 1, ov);
    const ret2 = await workflows.order.createReturn({ orderId: o2, lines: [{ orderItemId: line2, quantity: 1, restockable: true }] }, { actorUserId: null });
    if (ret2.ok) {
      const recv2 = await workflows.order.receiveReturn({ returnId: ret2.data.returnId }, { actorUserId: null });
      check("ledger: per-variant return restocks the VARIANT 3→4", recv2.ok === true && (await variantStockOf(ov)) === 4);
      const rows2 = await returnLedger(o2);
      check("ledger: per-variant return keeps its variant_id", rows2.length === 1 && rows2[0].variant_id === ov);
    } else {
      check("ledger: per-variant return created", false);
    }
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
