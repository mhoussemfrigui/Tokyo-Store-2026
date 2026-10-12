import "server-only";

/**
 * Order money integrity of a POST-SALE line edit (`workflows.order.editItems`).
 *
 *   PURE — the strict tax-config read + the shared order-tax rules:
 *     - readTaxConfig (behind getTaxConfigStrict) PROPAGATES a settings-read
 *       error (never resolves to mode "disabled") and parses the keys;
 *     - orderTaxMode reads the ORDER's own arithmetic (ttc-era stays ttc under a
 *       live ht, an order sold tax-free stays "disabled");
 *     - orderTaxIncludedInTotal / orderTotalLock.
 *   DB — the workflow on real rows (live mode "ht", on_shipping toggled):
 *     - a TTC-era order edited under live HT keeps its own mode (no TVA added on
 *       top, added line extracted ttc-style, no shipping TVA invented);
 *     - an HT order sold with shipping TVA keeps it after on_shipping is off;
 *     - an order sold tax-free gets no TVA on an added line;
 *     - a manual TVA override then set_qty → override cleared, rows sum to the
 *       total, history + order.edited say so;
 *     - a paid online order, a paid cash order and a pending online order with a
 *       gateway session REFUSE a total-changing edit (row + stock untouched); a
 *       total-neutral edit on the paid one still works; a pending online order
 *       with no session yet stays editable;
 *     - a per-variant line whose variant was removed since the sale never moves
 *       the PARENT's stock (untracked, like the cancel restock); a live variant
 *       line still moves the variant;
 *     - a no-op batch writes nothing and keeps the override.
 * Self-cleaning (`__oemtest…`); restores the settings it flips. Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/order-edit-money.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { orders, order_items } from "@/modules/order/schema";
import { orderService } from "@/modules/order/service";
import { bus } from "@/events/bus";
import { workflows } from "@/workflows";
import { readTaxConfig } from "@/lib/tax";
import { orderTaxIncludedInTotal, orderTaxMode, orderTotalLock } from "@/lib/order/order-tax-mode";

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

const TAG = "__oemtest";
const OPERATOR = `${TAG}-operator`;
const SETTING_KEYS = ["tax.mode", "tax.on_shipping", "tax.default_rate_bps", "checkout.min_order_cents"] as const;

// ── PURE ─────────────────────────────────────────────────────────────────────

/** subtotal 100 000, shipping 7 000 → base 107 000 (millimes). */
function money(over: Partial<Parameters<typeof orderTaxMode>[0]>) {
  return {
    subtotal_cents: 100_000,
    discount_cents: 0,
    shipping_cents: 7_000,
    tax_cents: 19_000,
    tax_manual_cents: null,
    total_cents: 126_000,
    ...over,
  };
}

async function pureChecks() {
  let threw = false;
  try {
    await readTaxConfig(() => Promise.reject(new Error("settings read failed")));
  } catch {
    threw = true;
  }
  check("pure: strict tax read PROPAGATES a settings-read error (never 'disabled')", threw);
  const parsed = await readTaxConfig(async () => ({
    "tax.mode": "ht",
    "tax.default_rate_bps": "700",
    "tax.on_shipping": "true",
  }));
  check(
    "pure: strict tax read parses mode / rate / on_shipping / default label",
    parsed.mode === "ht" && parsed.defaultRateBps === 700 && parsed.onShipping === true && parsed.label === "TVA",
  );

  const rated = [{ tax_rate_bps: 1900 }];
  check("pure: ht order (total = base + tax) → 'ht' even under live ttc", orderTaxMode(money({}), rated, "ttc") === "ht");
  check(
    "pure: ttc-era order (total = base) → 'ttc' even under live ht",
    orderTaxMode(money({ tax_cents: 15_966, total_cents: 107_000 }), rated, "ht") === "ttc",
  );
  check(
    "pure: order sold tax-free (no line rate) → 'disabled' even under live ht",
    orderTaxMode(money({ tax_cents: 0, total_cents: 107_000 }), [{ tax_rate_bps: null }], "ht") === "disabled",
  );
  check(
    "pure: zero-TVA order with rated (0 %) lines → no signal → live mode",
    orderTaxMode(money({ tax_cents: 0, total_cents: 107_000 }), [{ tax_rate_bps: 0 }], "ttc") === "ttc",
  );
  check(
    "pure: taxIncludedInTotal — ttc true, ht false, tax-free false",
    orderTaxIncludedInTotal(money({ tax_cents: 15_966, total_cents: 107_000 })) === true &&
      orderTaxIncludedInTotal(money({})) === false &&
      orderTaxIncludedInTotal(money({ tax_cents: 0, total_cents: 107_000 })) === false,
  );
  const lockOf = (over: Partial<Parameters<typeof orderTotalLock>[0]>) =>
    orderTotalLock({ status: "pending", paid_at: null, payment_method: "cod", payment_reference: null, ...over });
  check(
    "pure: total lock — paid_at → settled; pending online + ref → gateway_pending; else none",
    lockOf({ status: "paid", paid_at: new Date(), payment_method: "cash" }) === "settled" &&
      lockOf({ payment_method: "flouci", payment_reference: "gw" }) === "gateway_pending" &&
      lockOf({ payment_method: "flouci" }) === null &&
      lockOf({ status: "preparing", payment_method: "clictopay", payment_reference: "gw" }) === null,
  );
}

// ── DB ───────────────────────────────────────────────────────────────────────

async function cleanup() {
  const ours = sql`(select id from orders where order_number like ${TAG + "%"})`;
  await db.execute(sql`delete from stock_movements where order_id in ${ours}`);
  await db.execute(sql`delete from order_status_history where order_id in ${ours}`);
  await db.execute(sql`delete from order_items where order_id in ${ours}`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
  await db.execute(sql`delete from stock_movements where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from product_variants where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
  await db.execute(sql`delete from audit_log where actor_user_id = ${OPERATOR}`);
}

const priorSettings = new Map<string, string | null>();
async function captureSettings() {
  for (const key of SETTING_KEYS) {
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
  for (const key of SETTING_KEYS) {
    if (priorSettings.has(key)) {
      await db.execute(sql`update site_settings set value = ${priorSettings.get(key) ?? null} where key = ${key}`);
    } else {
      await db.execute(sql`delete from site_settings where key = ${key}`);
    }
  }
}

let seq = 0;
async function mkProduct(price: number, stock: number | null, over: Record<string, unknown> = {}) {
  seq += 1;
  const [p] = await db
    .insert(products)
    .values({
      slug: `${TAG}-p${seq}-${Date.now()}`,
      name: `${TAG} P${seq}`,
      price_cents: price,
      stock_qty: stock,
      in_stock: true,
      is_published: true,
      ...over,
    } as never)
    .returning({ id: products.id });
  return p.id;
}
async function mkVariant(productId: string, label: string, stock: number) {
  const [v] = await db
    .insert(product_variants)
    .values({ product_id: productId, sku: `${TAG}-${label}-${Date.now()}`, label, price_cents: 10_000, stock_qty: stock, in_stock: true } as never)
    .returning({ id: product_variants.id });
  return v.id;
}
async function mkOrder(over: Record<string, unknown>) {
  seq += 1;
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-${seq}-${Date.now()}`,
      contact_email: "oem@example.com",
      status: "pending",
      payment_method: "cod",
      subtotal_cents: 0,
      shipping_cents: 0,
      tax_cents: 0,
      total_cents: 0,
      ship_full_name: "OEM",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
      ...over,
    } as never)
    .returning({ id: orders.id });
  return o.id;
}
async function mkItem(
  orderId: string,
  productId: string,
  qty: number,
  unit: number,
  over: { tax_cents?: number; tax_rate_bps?: number | null; variant_id?: string | null } = {},
) {
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
      tax_cents: 0,
      tax_rate_bps: null,
      ...over,
    } as never)
    .returning({ id: order_items.id });
  return it.id;
}
async function orderRow(id: string) {
  const [r] = await db.select().from(orders).where(sql`${orders.id} = ${id}`);
  return r;
}
async function productStock(id: string): Promise<number | null> {
  const [r] = await db.select({ s: products.stock_qty }).from(products).where(sql`${products.id} = ${id}`);
  return r?.s ?? null;
}
async function variantStock(id: string): Promise<number | null> {
  const [r] = await db.select({ s: product_variants.stock_qty }).from(product_variants).where(sql`${product_variants.id} = ${id}`);
  return r?.s ?? null;
}
async function historyNotes(id: string): Promise<string[]> {
  const r = await db.execute(sql`select notes from order_status_history where order_id = ${id} order by created_at`);
  return (r.rows as Array<{ notes: string | null }>).map((x) => x.notes ?? "");
}
/** The documents' identity: base + (tax on top ? printed TVA : 0) === total. */
function rowsReconcile(o: Awaited<ReturnType<typeof orderRow>>): boolean {
  const printed = o.tax_manual_cents ?? o.tax_cents;
  const base = o.subtotal_cents + o.shipping_cents - o.discount_cents;
  return base + (orderTaxIncludedInTotal(o) ? 0 : printed) === o.total_cents;
}

async function main() {
  await pureChecks();

  await cleanup();
  await captureSettings();

  const edited: Array<{ orderId: string; changedFields?: string[] }> = [];
  bus.on("order.edited", (env) => {
    edited.push({ orderId: env.payload.orderId, changedFields: env.payload.changedFields });
  });
  const edit = (orderId: string, ops: Parameters<typeof workflows.order.editItems>[0]["ops"]) =>
    workflows.order.editItems({ orderId, ops }, { actorUserId: OPERATOR });

  try {
    await setSetting("tax.mode", "ht");
    await setSetting("tax.default_rate_bps", "1900");
    await setSetting("tax.on_shipping", "true");
    await setSetting("checkout.min_order_cents", "0");

    const p119 = await mkProduct(119_000, null);
    const p11900 = await mkProduct(11_900, null);
    const p100 = await mkProduct(100_000, null);

    // ── TTC-era order edited under live HT (+ on_shipping ON) keeps its mode.
    {
      // 2 × 119 000 TTC (19 000 TVA each) + 7 000 shipping (no shipping TVA) = 245 000.
      const o = await mkOrder({ subtotal_cents: 238_000, shipping_cents: 7_000, tax_cents: 38_000, total_cents: 245_000 });
      await mkItem(o, p119, 1, 119_000, { tax_cents: 19_000, tax_rate_bps: 1900 });
      const l2 = await mkItem(o, p119, 1, 119_000, { tax_cents: 19_000, tax_rate_bps: 1900 });
      const r = await edit(o, [
        { kind: "set_qty", orderItemId: l2, quantity: 2 },
        { kind: "add", productId: p11900, quantity: 1 },
      ]);
      const a = await orderRow(o);
      const items = await orderService.listItems(o);
      const added = items.find((i) => i.product_id === p11900);
      const grown = items.find((i) => i.id === l2);
      check("ttc-era: edit ok", r.ok === true);
      check("ttc-era: grown line re-taxed TTC (238 000 → 38 000 extracted)", grown?.tax_cents === 38_000);
      check("ttc-era: added line extracted TTC (11 900 → 1 900) at the cascade rate", added?.tax_cents === 1_900 && added?.tax_rate_bps === 1900);
      check("ttc-era: no shipping TVA invented by the live on_shipping flag", a.tax_cents === 19_000 + 38_000 + 1_900);
      check("ttc-era: total = base (TVA NOT added on top): 368 900 + 7 000", a.total_cents === 375_900);
      check("ttc-era: order still reads TTC + rows reconcile", orderTaxIncludedInTotal(a) && rowsReconcile(a));
    }

    // ── HT order sold with shipping TVA keeps it after on_shipping is turned off.
    await setSetting("tax.on_shipping", "false");
    {
      // 100 000 + 7 000 + (19 000 line TVA + 1 330 shipping TVA) = 127 330.
      const o = await mkOrder({ subtotal_cents: 100_000, shipping_cents: 7_000, tax_cents: 20_330, total_cents: 127_330 });
      const l = await mkItem(o, p100, 1, 100_000, { tax_cents: 19_000, tax_rate_bps: 1900 });
      const r = await edit(o, [{ kind: "set_qty", orderItemId: l, quantity: 2 }]);
      const a = await orderRow(o);
      check("ht shipping TVA: edit ok", r.ok === true);
      check("ht shipping TVA: the sale's 1 330 shipping TVA kept (38 000 + 1 330)", a.tax_cents === 39_330);
      check("ht shipping TVA: total = 207 000 + 39 330 (on top)", a.total_cents === 246_330 && rowsReconcile(a));
    }

    // ── Order sold tax-free (no line rate): an added line gets no TVA under live ht.
    {
      const p50 = await mkProduct(50_000, null);
      const o = await mkOrder({ subtotal_cents: 50_000, shipping_cents: 7_000, total_cents: 57_000 });
      await mkItem(o, p50, 1, 50_000);
      const r = await edit(o, [{ kind: "add", productId: p11900, quantity: 1 }]);
      const a = await orderRow(o);
      const added = (await orderService.listItems(o)).find((i) => i.product_id === p11900);
      check("tax-free order: add ok", r.ok === true);
      check("tax-free order: added line carries no TVA / no rate", added?.tax_cents === 0 && added?.tax_rate_bps === null);
      check("tax-free order: total = 61 900 + 7 000, tax 0", a.total_cents === 68_900 && a.tax_cents === 0);
    }

    // ── Manual TVA override, then set_qty → override cleared, rows add up.
    {
      const o = await mkOrder({ subtotal_cents: 100_000, shipping_cents: 7_000, tax_cents: 19_000, total_cents: 126_000 });
      const l = await mkItem(o, p100, 1, 100_000, { tax_cents: 19_000, tax_rate_bps: 1900 });
      const m = await workflows.order.setInvoiceTax({ orderId: o, mode: "manual", amountCents: 20_000 }, { actorUserId: OPERATOR });
      check("manual: override set (ht total 127 000)", m.ok === true && (await orderRow(o)).total_cents === 127_000);

      // A no-op batch (same qty) writes nothing and keeps the override.
      const historyBefore = (await historyNotes(o)).length;
      const eventsBefore = edited.filter((e) => e.orderId === o).length;
      const noop = await edit(o, [{ kind: "set_qty", orderItemId: l, quantity: 1 }]);
      const n = await orderRow(o);
      check("no-op: ok, override + total kept", noop.ok === true && n.tax_manual_cents === 20_000 && n.total_cents === 127_000);
      check(
        "no-op: no history row, no order.edited",
        (await historyNotes(o)).length === historyBefore && edited.filter((e) => e.orderId === o).length === eventsBefore,
      );

      const r = await edit(o, [{ kind: "set_qty", orderItemId: l, quantity: 2 }]);
      const a = await orderRow(o);
      check("manual: set_qty ok", r.ok === true);
      check("manual: override cleared", a.tax_manual_cents === null);
      check("manual: computed TVA 38 000, total 207 000 + 38 000", a.tax_cents === 38_000 && a.total_cents === 245_000);
      check("manual: printed rows sum to the total", rowsReconcile(a));
      const notes = await historyNotes(o);
      check("manual: history notes the reset", (notes.at(-1) ?? "").includes("manuelle réinitialisée"));
      const ev = edited.filter((e) => e.orderId === o).at(-1);
      check("manual: order.edited lists tax_manual_cents", ev?.changedFields?.includes("tax_manual_cents") === true);
    }

    // ── Total lock: settled / in-flight orders refuse a total-changing edit.
    {
      const pTracked = await mkProduct(10_000, 5);
      const pSwap = await mkProduct(10_000, null);

      // Paid ONLINE order (captured 10 000).
      const paid = await mkOrder({
        status: "paid",
        payment_method: "clictopay",
        payment_reference: "gw-paid",
        paid_at: new Date(),
        subtotal_cents: 10_000,
        total_cents: 10_000,
      });
      const pl = await mkItem(paid, pTracked, 1, 10_000);
      const grow = await edit(paid, [{ kind: "set_qty", orderItemId: pl, quantity: 2 }]);
      const ga = await orderRow(paid);
      check("lock: paid online order, growing refused (conflict)", grow.ok === false && grow.error === "conflict");
      check("lock: …total + stock untouched", ga.total_cents === 10_000 && (await productStock(pTracked)) === 5);
      const addLine = await edit(paid, [{ kind: "add", productId: pSwap, quantity: 1 }]);
      check("lock: paid online order, adding a line refused", addLine.ok === false && addLine.error === "conflict");

      // A total-NEUTRAL edit (swap for an equally priced line) still works.
      const swap = await edit(paid, [
        { kind: "remove", orderItemId: pl },
        { kind: "add", productId: pSwap, quantity: 1 },
      ]);
      const sa = await orderRow(paid);
      const swapped = await orderService.listItems(paid);
      check("lock: total-neutral swap on the paid order ok", swap.ok === true && sa.total_cents === 10_000);
      check(
        "lock: …line swapped + removed unit restocked (5 → 6)",
        swapped.length === 1 && swapped[0].product_id === pSwap && (await productStock(pTracked)) === 6,
      );

      // Paid CASH order (settled at the counter) — same rule.
      const cash = await mkOrder({ status: "paid", payment_method: "cash", paid_at: new Date(), subtotal_cents: 10_000, total_cents: 10_000 });
      const cl = await mkItem(cash, pSwap, 1, 10_000);
      const cashGrow = await edit(cash, [{ kind: "set_qty", orderItemId: cl, quantity: 3 }]);
      check("lock: paid cash order, growing refused", cashGrow.ok === false && cashGrow.error === "conflict");

      // Pending online order WITH a gateway session.
      const inflight = await mkOrder({ payment_method: "flouci", payment_reference: "gw-live", subtotal_cents: 10_000, total_cents: 10_000 });
      const il = await mkItem(inflight, pSwap, 1, 10_000);
      const inflightGrow = await edit(inflight, [{ kind: "set_qty", orderItemId: il, quantity: 2 }]);
      const ia = await orderRow(inflight);
      check("lock: pending online order with a session, growing refused", inflightGrow.ok === false && inflightGrow.error === "conflict");
      check("lock: …total untouched", ia.total_cents === 10_000);

      // Pending online order with NO session yet — still editable.
      const noSession = await mkOrder({ payment_method: "flouci", subtotal_cents: 10_000, total_cents: 10_000 });
      const nl = await mkItem(noSession, pSwap, 1, 10_000);
      const nsGrow = await edit(noSession, [{ kind: "set_qty", orderItemId: nl, quantity: 2 }]);
      check("lock: pending online order without a session stays editable", nsGrow.ok === true && (await orderRow(noSession)).total_cents === 20_000);
    }

    // ── Per-variant lines: a variant removed since the sale never moves the
    //    PARENT's stock; a live variant line still moves the variant (tx reads).
    {
      const pv = await mkProduct(10_000, 10, { product_type: "variable", shared_variant_stock: false });
      const vGone = await mkVariant(pv, "Gone", 5);
      const vLive = await mkVariant(pv, "Live", 5);
      const o = await mkOrder({ status: "preparing", subtotal_cents: 20_000, total_cents: 20_000 });
      const gl = await mkItem(o, pv, 1, 10_000, { variant_id: vGone });
      const ll = await mkItem(o, pv, 1, 10_000, { variant_id: vLive });
      await db.execute(sql`update product_variants set deleted_at = now() where id = ${vGone}`);

      const rm = await edit(o, [{ kind: "remove", orderItemId: gl }]);
      check("variant: removing a line whose variant was deleted ok", rm.ok === true);
      check("variant: …parent stock NOT moved (10)", (await productStock(pv)) === 10);
      check("variant: …deleted variant untouched (5)", (await variantStock(vGone)) === 5);

      const grow = await edit(o, [{ kind: "set_qty", orderItemId: ll, quantity: 2 }]);
      check("variant: growing a live variant line ok", grow.ok === true);
      check("variant: …variant claimed 5 → 4, parent still 10", (await variantStock(vLive)) === 4 && (await productStock(pv)) === 10);
    }
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
