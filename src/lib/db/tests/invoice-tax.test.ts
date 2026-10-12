import "server-only";

/**
 * Invoice TVA override (admin "TVA facture") — `workflows.order.setInvoiceTax`.
 *
 *   PURE — planInvoiceTaxChange / orderChargesTaxOnTop:
 *     - a numbered invoice OR credit note freezes the TVA (avoir route);
 *     - "tax on top" is inferred from the ORDER's arithmetic, so a ttc-era order
 *       never gets its TVA added to the total after the store switches to ht;
 *     - the total moves only while the amount is still to collect: refused once
 *       paid, once shipped, or under an in-flight gateway payment;
 *     - a request that changes nothing is a no-op.
 *   DB — the workflow on real rows (live mode "ht"):
 *     - manual override on a ttc-style order leaves the total alone;
 *     - manual override on an unpaid ht order rebuilds the total;
 *     - refused on a paid ht order and on an invoiced order (row untouched);
 *     - "global" re-sums the line snapshots + the order's OWN shipping TVA
 *       (`tax_cents − Σ line tax`, not the live on_shipping flag) + clears the
 *       override;
 *     - every change writes a same-status history row with the actor and emits
 *       `order.edited` (audit_log + webhooks) with the actor + changed fields;
 *     - tax disabled: an order SOLD with TVA stays correctable, one carrying
 *       none is refused.
 * Self-cleaning (`__ittest…`); restores the tax settings it flips. Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/invoice-tax.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { orders, order_items } from "@/modules/order/schema";
import { bus } from "@/events/bus";
import { workflows } from "@/workflows";
import {
  orderChargesTaxOnTop,
  planInvoiceTaxChange,
  type InvoiceTaxOrder,
} from "@/workflows/order/set-invoice-tax";
import {
  orderChargesTaxOnTop as sharedOrderChargesTaxOnTop,
  orderTotalLock,
} from "@/lib/order/order-tax-mode";

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

const TAG = "__ittest";
const OPERATOR = `${TAG}-operator`;
const TAX_KEYS = ["tax.mode", "tax.on_shipping"] as const;

// ── PURE ─────────────────────────────────────────────────────────────────────

/** subtotal 100 000, shipping 7 000 → base 107 000 (millimes). */
function snap(over: Partial<InvoiceTaxOrder>): InvoiceTaxOrder {
  return {
    status: "pending",
    subtotal_cents: 100_000,
    discount_cents: 0,
    shipping_cents: 7_000,
    tax_cents: 19_000,
    tax_manual_cents: null,
    total_cents: 126_000,
    care_cents: 0,
    paid_at: null,
    payment_method: "cod",
    payment_reference: null,
    invoice_number: null,
    credit_note_number: null,
    ...over,
  };
}

function pureChecks() {
  const htUnpaid = snap({}); // total = base + tax → tax on top
  const ttcOrder = snap({ tax_cents: 15_966, total_cents: 107_000 }); // total = base → included

  check("pure: ht order detected as tax-on-top", orderChargesTaxOnTop(htUnpaid, "ttc") === true);
  check("pure: ttc-era order NOT on top even under live ht", orderChargesTaxOnTop(ttcOrder, "ht") === false);
  check(
    "pure: zero-tax order falls back to the live mode",
    orderChargesTaxOnTop(snap({ tax_cents: 0, total_cents: 107_000 }), "ht") === true &&
      orderChargesTaxOnTop(snap({ tax_cents: 0, total_cents: 107_000 }), "ttc") === false,
  );

  check(
    "pure: set-invoice-tax re-exports the SHARED order-tax-mode helper",
    orderChargesTaxOnTop === sharedOrderChargesTaxOnTop,
  );
  check(
    "pure: total lock — paid → settled, pending online w/ ref → gateway_pending, COD → none",
    orderTotalLock(snap({ status: "paid", paid_at: new Date() })) === "settled" &&
      orderTotalLock(snap({ payment_method: "clictopay", payment_reference: "gw-1" })) === "gateway_pending" &&
      orderTotalLock(snap({ payment_method: "clictopay", payment_reference: null })) === null &&
      orderTotalLock(snap({})) === null,
  );

  const inv = planInvoiceTaxChange(snap({ invoice_number: "FA-1" }), { taxCents: 19_000, taxManualCents: 1 }, "ht");
  check("pure: invoiced → refused (conflict)", inv.kind === "refuse" && inv.error.error === "conflict");
  const avoir = planInvoiceTaxChange(snap({ credit_note_number: "AV-1" }), { taxCents: 19_000, taxManualCents: 1 }, "ht");
  check("pure: credit note issued → refused", avoir.kind === "refuse");

  const ttcManual = planInvoiceTaxChange(ttcOrder, { taxCents: 15_966, taxManualCents: 16_000 }, "ht");
  check(
    "pure: ttc-era order manual TVA → total unchanged",
    ttcManual.kind === "ok" && ttcManual.totalCents === 107_000 && !ttcManual.totalChanged && ttcManual.changed,
  );

  const htManual = planInvoiceTaxChange(htUnpaid, { taxCents: 19_000, taxManualCents: 20_000 }, "ht");
  check(
    "pure: unpaid ht order manual TVA → total rebuilt 107 000 + 20 000",
    htManual.kind === "ok" && htManual.totalCents === 127_000 && htManual.totalChanged,
  );

  const paid = planInvoiceTaxChange(snap({ status: "paid", paid_at: new Date() }), { taxCents: 19_000, taxManualCents: 20_000 }, "ht");
  check("pure: paid ht order whose total would move → refused", paid.kind === "refuse" && paid.error.error === "conflict");
  const paidTtc = planInvoiceTaxChange(
    { ...ttcOrder, status: "paid", paid_at: new Date() },
    { taxCents: 15_966, taxManualCents: 16_000 },
    "ht",
  );
  check("pure: paid ttc order (display-only change) → allowed", paidTtc.kind === "ok" && !paidTtc.totalChanged);

  const shipped = planInvoiceTaxChange(snap({ status: "shipped" }), { taxCents: 19_000, taxManualCents: 20_000 }, "ht");
  check("pure: shipped unpaid COD ht order → refused", shipped.kind === "refuse" && shipped.error.error === "invalid_status");

  const inFlight = planInvoiceTaxChange(
    snap({ payment_method: "flouci", payment_reference: "gw-123" }),
    { taxCents: 19_000, taxManualCents: 20_000 },
    "ht",
  );
  check("pure: pending online order with a gateway session → refused", inFlight.kind === "refuse");

  const noop = planInvoiceTaxChange(
    snap({ status: "paid", paid_at: new Date(), tax_manual_cents: 20_000, total_cents: 127_000 }),
    { taxCents: 19_000, taxManualCents: 20_000 },
    "ht",
  );
  check("pure: identical request on a paid order → no-op (not refused)", noop.kind === "ok" && !noop.changed);
}

// ── DB ───────────────────────────────────────────────────────────────────────

async function cleanup() {
  await db.execute(sql`delete from order_status_history where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from order_items where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from audit_log where actor_user_id = ${OPERATOR}`);
}

const priorSettings = new Map<string, string | null>();
async function captureSettings() {
  for (const key of TAX_KEYS) {
    const r = await db.execute(sql`select value from site_settings where key = ${key}`);
    const rows = r.rows as Array<{ value: string | null }>;
    if (rows.length > 0) priorSettings.set(key, rows[0].value);
  }
}
async function setSetting(key: string, value: string) {
  await db.execute(
    sql`insert into site_settings (key, value, type, label) values (${key}, ${value}, 'text', ${key})
        on conflict (key) do update set value = ${value}`,
  );
}
async function restoreSettings() {
  for (const key of TAX_KEYS) {
    if (priorSettings.has(key)) {
      await db.execute(sql`update site_settings set value = ${priorSettings.get(key) ?? null} where key = ${key}`);
    } else {
      await db.execute(sql`delete from site_settings where key = ${key}`);
    }
  }
}

let seq = 0;
async function mkOrder(over: Record<string, unknown>) {
  seq += 1;
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-${seq}-${Date.now()}`,
      contact_email: "it@example.com",
      status: "pending",
      payment_method: "cod",
      subtotal_cents: 100_000,
      shipping_cents: 7_000,
      tax_cents: 19_000,
      total_cents: 126_000,
      ship_full_name: "IT",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
      ...over,
    } as never)
    .returning({ id: orders.id });
  return o.id;
}

async function orderRow(id: string) {
  const [r] = await db.select().from(orders).where(sql`${orders.id} = ${id}`);
  return r;
}

async function historyNotes(id: string): Promise<Array<{ actor: string | null; notes: string | null }>> {
  const r = await db.execute(
    sql`select actor_user_id as actor, notes from order_status_history where order_id = ${id} order by created_at`,
  );
  return r.rows as Array<{ actor: string | null; notes: string | null }>;
}

async function main() {
  pureChecks();

  await cleanup();
  await captureSettings();

  const edited: Array<{ orderId: string; changedFields?: string[]; actor: string | null | undefined }> = [];
  bus.on("order.edited", (env) => {
    edited.push({ orderId: env.payload.orderId, changedFields: env.payload.changedFields, actor: env.actorUserId });
  });

  try {
    await setSetting("tax.mode", "ht");
    await setSetting("tax.on_shipping", "false");

    // ── ttc-style order under live ht: TVA changes, total stays as charged.
    const ttcId = await mkOrder({ tax_cents: 15_966, total_cents: 107_000 });
    const r1 = await workflows.order.setInvoiceTax({ orderId: ttcId, mode: "manual", amountCents: 16_000 }, { actorUserId: OPERATOR });
    const a1 = await orderRow(ttcId);
    check("db: ttc-era manual TVA ok", r1.ok === true);
    check("db: ttc-era override stored", a1.tax_manual_cents === 16_000);
    check("db: ttc-era total untouched (107 000)", a1.total_cents === 107_000);
    const ev1 = edited.find((e) => e.orderId === ttcId);
    check(
      "db: order.edited emitted with actor + tax fields only",
      ev1 != null && ev1.actor === OPERATOR && JSON.stringify(ev1.changedFields) === JSON.stringify(["tax_cents", "tax_manual_cents"]),
    );
    const h1 = await historyNotes(ttcId);
    check(
      "db: timeline row written with the operator as actor",
      h1.length === 1 && h1[0].actor === OPERATOR && (h1[0].notes ?? "").includes("saisie manuelle"),
    );

    // ── unpaid ht order: total rebuilt = base + new TVA.
    const htId = await mkOrder({});
    const r2 = await workflows.order.setInvoiceTax({ orderId: htId, mode: "manual", amountCents: 20_000 }, { actorUserId: OPERATOR });
    const a2 = await orderRow(htId);
    check("db: unpaid ht manual TVA ok + reports totalChanged", r2.ok === true && r2.data.totalChanged === true);
    check("db: unpaid ht total rebuilt 126 000 → 127 000", a2.total_cents === 127_000);
    const ev2 = edited.find((e) => e.orderId === htId);
    check("db: order.edited lists total_cents when the total moved", ev2?.changedFields?.includes("total_cents") === true);

    // ── same request again → no-op (no event, no extra history row).
    const before = edited.length;
    const r2b = await workflows.order.setInvoiceTax({ orderId: htId, mode: "manual", amountCents: 20_000 }, { actorUserId: OPERATOR });
    check("db: identical request → ok, changed=false", r2b.ok === true && r2b.data.changed === false);
    check("db: no-op emits nothing", edited.length === before);
    check("db: no-op writes no history row", (await historyNotes(htId)).length === 1);

    // ── "global": re-sum line snapshots + the order's OWN shipping TVA + clear
    // the override. The order (tax_cents 19 000) was sold with 1 330 of
    // shipping TVA over its 17 670 of line TVA; the live on_shipping flag is
    // OFF now — the sale's shipping TVA must survive "Recalculer" anyway.
    const [p] = await db
      .insert(products)
      .values({ slug: `${TAG}-p`, name: `${TAG} P`, price_cents: 50_000, is_published: true } as never)
      .returning({ id: products.id });
    await db.insert(order_items).values([
      { order_id: htId, product_id: p.id, product_name: `${TAG} a`, product_slug: `${TAG}-a`, unit_price_cents: 50_000, quantity: 1, subtotal_cents: 50_000, tax_cents: 8_835 },
      { order_id: htId, product_id: p.id, product_name: `${TAG} b`, product_slug: `${TAG}-b`, unit_price_cents: 50_000, quantity: 1, subtotal_cents: 50_000, tax_cents: 8_835 },
    ] as never);
    const r3 = await workflows.order.setInvoiceTax({ orderId: htId, mode: "global" }, { actorUserId: OPERATOR });
    const a3 = await orderRow(htId);
    check("db: global recompute ok", r3.ok === true);
    check("db: global → tax_cents = Σ line snapshots + sale shipping TVA (17 670 + 1 330)", a3.tax_cents === 19_000);
    check("db: global → manual override cleared", a3.tax_manual_cents === null);
    check("db: global → unpaid ht total = 107 000 + 19 000", a3.total_cents === 126_000);

    // ── paid ht order: the total is the captured amount → refused, row untouched.
    const paidId = await mkOrder({ status: "paid", payment_method: "cash", paid_at: new Date() });
    const r4 = await workflows.order.setInvoiceTax({ orderId: paidId, mode: "manual", amountCents: 25_000 }, { actorUserId: OPERATOR });
    const a4 = await orderRow(paidId);
    check("db: paid ht order → refused", r4.ok === false && r4.error === "conflict");
    check("db: paid ht order untouched", a4.tax_manual_cents === null && a4.total_cents === 126_000);

    // ── invoiced order: fiscal lock.
    const invId = await mkOrder({ tax_cents: 15_966, total_cents: 107_000, invoice_number: `${TAG}-FA-${Date.now()}` });
    const r5 = await workflows.order.setInvoiceTax({ orderId: invId, mode: "manual", amountCents: 1 }, { actorUserId: OPERATOR });
    const a5 = await orderRow(invId);
    check("db: invoiced order → refused (conflict)", r5.ok === false && r5.error === "conflict");
    check("db: invoiced order untouched", a5.tax_manual_cents === null);

    // ── validation: negative / non-integer amounts never reach the DB.
    const r6 = await workflows.order.setInvoiceTax({ orderId: ttcId, mode: "manual", amountCents: -1 }, { actorUserId: OPERATOR });
    check("db: negative amount → validation", r6.ok === false && r6.error === "validation");

    // ── tax disabled since the sale: an order SOLD with TVA stays correctable
    // (its invoice still prints that TVA); one carrying none is refused.
    await setSetting("tax.mode", "disabled");
    const r7 = await workflows.order.setInvoiceTax({ orderId: ttcId, mode: "global" }, { actorUserId: OPERATOR });
    const a7 = await orderRow(ttcId);
    check("db: tax disabled, order sold with TVA → Recalculer ok", r7.ok === true);
    check(
      "db: …override cleared, sale TVA kept, ttc total untouched",
      a7.tax_manual_cents === null && a7.tax_cents === 15_966 && a7.total_cents === 107_000,
    );
    const noTaxId = await mkOrder({ tax_cents: 0, total_cents: 107_000 });
    const r8 = await workflows.order.setInvoiceTax({ orderId: noTaxId, mode: "manual", amountCents: 1_000 }, { actorUserId: OPERATOR });
    check("db: tax disabled, order carrying no TVA → refused", r8.ok === false && r8.error === "tax_disabled");
    check("db: …row untouched", (await orderRow(noTaxId)).tax_manual_cents === null);
  } finally {
    await restoreSettings();
    await cleanup();
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await restoreSettings();
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
