import "server-only";

/**
 * Order-side events (A–Z 09-23, phase 3 — orders-23/25, inventory alerts):
 *   PLAN  — the shared stock-crossing planner (lib/inventory/stock-alerts):
 *           per-row net change (first before / last after), low / rupture only
 *           when the low-stock toggle is on, back-in-stock once per product.
 *   TRAIL — the customer trail drops same-status history rows (an operator
 *           line edit's audit marker) but keeps the placement row + real moves.
 *   EDIT  — an admin order-line edit raises the same crossing events as a sale:
 *           growing a line under the threshold → product.stock_low, to 0 →
 *           product.stock_depleted (variant SKU/label carried), removing a line
 *           that brings a sold-out row back → product.restocked; with the toggle
 *           off only the back-in-stock event fires.
 *   PAID  — order.paid fires whenever the transition stamps paid_at: COD at
 *           `delivered` (settledAt "delivery", once), an online order at `paid`
 *           ("gateway", not again at delivery), a cash order at `paid` ("manual").
 * Self-cleaning (`__ordevt…`; the two low-stock settings are restored). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/order-events.test.ts
 */
import { sql } from "drizzle-orm";

import { bus, type EventPayload } from "@/events/bus";
import { db } from "@/lib/db/client";
import { LOW_STOCK_DEFAULTS } from "@/lib/inventory/low-stock";
import {
  mergeStockLevelChanges,
  planStockCrossingEvents,
  type StockLevelChange,
} from "@/lib/inventory/stock-alerts";
import { customerTrailEvents } from "@/components/storefront/order-steps";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { orders, order_items } from "@/modules/order/schema";
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

const TAG = "__ordevt";
const SETTING_KEYS = ["stock.alert_enabled", "stock.low_threshold_qty"] as const;
let savedSettings: Map<string, string | null> | null = null;

async function readSettings(): Promise<Map<string, string | null>> {
  const r = await db.execute(sql`select key, value from site_settings where key in ('stock.alert_enabled', 'stock.low_threshold_qty')`);
  return new Map((r.rows as Array<{ key: string; value: string | null }>).map((x) => [x.key, x.value]));
}
async function putSetting(key: string, value: string) {
  await db.execute(
    sql`insert into site_settings (key, value, label) values (${key}, ${value}, ${TAG}) on conflict (key) do update set value = excluded.value`,
  );
}
async function restoreSettings() {
  if (!savedSettings) return;
  for (const key of SETTING_KEYS) {
    if (savedSettings.has(key)) {
      await db.execute(sql`update site_settings set value = ${savedSettings.get(key) ?? null} where key = ${key}`);
    } else {
      await db.execute(sql`delete from site_settings where key = ${key}`);
    }
  }
}

async function cleanup() {
  const mine = sql`(select id from orders where order_number like ${TAG + "%"})`;
  await db.execute(sql`delete from shipment_items where shipment_id in (select id from shipments where order_id in ${mine})`);
  await db.execute(sql`delete from shipments where order_id in ${mine}`);
  await db.execute(sql`delete from stock_movements where order_id in ${mine}`);
  await db.execute(sql`delete from order_status_history where order_id in ${mine}`);
  await db.execute(sql`delete from order_items where order_id in ${mine}`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
  await db.execute(sql`delete from product_variants where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

async function mkProduct(slug: string, stock: number, extra: Record<string, unknown> = {}) {
  const [p] = await db
    .insert(products)
    .values({ slug: `${TAG}-${slug}`, name: `${TAG} ${slug}`, sku: `${TAG}-${slug}`, price_cents: 1000, stock_qty: stock, in_stock: true, is_published: true, ...extra } as never)
    .returning({ id: products.id });
  return p.id;
}
async function mkVariant(productId: string, label: string, stock: number) {
  const [v] = await db
    .insert(product_variants)
    .values({ product_id: productId, sku: `${TAG}-${label}`, label, price_cents: 1000, stock_qty: stock, in_stock: true } as never)
    .returning({ id: product_variants.id });
  return v.id;
}
async function mkOrder(tag: string, status: string, paymentMethod: string) {
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-${tag}-${Date.now()}`,
      contact_email: "oe@example.test",
      status,
      payment_method: paymentMethod,
      subtotal_cents: 0,
      total_cents: 0,
      ship_full_name: "OE",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
    } as never)
    .returning({ id: orders.id });
  return o.id;
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
      unit_price_cents: 1000,
      quantity: qty,
      subtotal_cents: 1000 * qty,
    } as never)
    .returning({ id: order_items.id });
  return it.id;
}
async function paidAtOf(orderId: string): Promise<Date | null> {
  const [r] = await db.select({ p: orders.paid_at }).from(orders).where(sql`${orders.id} = ${orderId}`);
  return r?.p ?? null;
}

// ── Captured bus events (the real emit path, observed from a listener).
const lows: EventPayload<"product.stock_low">[] = [];
const depleted: EventPayload<"product.stock_depleted">[] = [];
const restocked: EventPayload<"product.restocked">[] = [];
const paid: EventPayload<"order.paid">[] = [];
bus.on("product.stock_low", ({ payload }) => void lows.push(payload));
bus.on("product.stock_depleted", ({ payload }) => void depleted.push(payload));
bus.on("product.restocked", ({ payload }) => void restocked.push(payload));
bus.on("order.paid", ({ payload }) => void paid.push(payload));
function resetCaptured() {
  lows.length = 0;
  depleted.length = 0;
  restocked.length = 0;
}

function change(p: Partial<StockLevelChange> & Pick<StockLevelChange, "prevQty" | "newQty">): StockLevelChange {
  return { productId: "p1", variantId: null, sku: "S", name: "N", variantLabel: null, ...p };
}

async function main() {
  // ── PLAN (pure) ───────────────────────────────────────────────────────────
  {
    const on = { ...LOW_STOCK_DEFAULTS, enabled: true, threshold: 5 };
    const merged = mergeStockLevelChanges([
      change({ prevQty: 6, newQty: 8 }),
      change({ prevQty: 8, newQty: 3 }),
      change({ variantId: "v1", prevQty: 2, newQty: 1 }),
    ]);
    check("plan: same row merged — first before, last after (6→3)", merged.length === 2 && merged[0].prevQty === 6 && merged[0].newQty === 3);
    check("plan: a different variant stays its own row", merged[1].variantId === "v1");

    const low = planStockCrossingEvents([change({ prevQty: 6, newQty: 8 }), change({ prevQty: 8, newQty: 3 })], { lowStock: on });
    check("plan: net 6→3 across threshold 5 → ONE stock_low (currentQty 3)", low.length === 1 && low[0].name === "product.stock_low" && low[0].payload.productId === "p1" && (low[0].payload as { currentQty: number }).currentQty === 3);
    const dep = planStockCrossingEvents([change({ prevQty: 4, newQty: 1 }), change({ prevQty: 1, newQty: 0 })], { lowStock: on });
    check("plan: a batch ending at 0 → ONE stock_depleted (no extra low)", dep.length === 1 && dep[0].name === "product.stock_depleted");
    const off = planStockCrossingEvents([change({ prevQty: 4, newQty: 0 })], { lowStock: { ...on, enabled: false } });
    check("plan: toggle OFF → no low/rupture event", off.length === 0);
    const back = planStockCrossingEvents(
      [change({ prevQty: 0, newQty: 2 }), change({ variantId: "v2", prevQty: -1, newQty: 1 }), change({ productId: "p2", prevQty: 3, newQty: 5 })],
      { lowStock: on, restocked: true },
    );
    check(
      "plan: sold-out → positive = ONE product.restocked per product (p1 once, p2 none)",
      back.length === 1 && back[0].name === "product.restocked" && back[0].payload.productId === "p1",
    );
    check("plan: restocked is opt-in", planStockCrossingEvents([change({ prevQty: 0, newQty: 2 })], { lowStock: on }).length === 0);
    check("plan: a restock never raises a low/rupture alert", planStockCrossingEvents([change({ prevQty: 1, newQty: 9 })], { lowStock: on, restocked: true }).length === 0);
  }

  // ── TRAIL (pure) ──────────────────────────────────────────────────────────
  {
    const t0 = new Date("2026-09-20T10:00:00Z");
    const t1 = new Date("2026-09-20T11:00:00Z");
    const t2 = new Date("2026-09-20T12:00:00Z");
    const trail = customerTrailEvents([
      { from_status: "paid", to_status: "paid", created_at: t2 }, // line-edit audit marker
      { from_status: "pending", to_status: "paid", created_at: t1 },
      { from_status: null, to_status: "pending", created_at: t0 }, // placement
    ]);
    check("trail: same-status edit row dropped, real moves kept (2 events)", trail.length === 2);
    check("trail: order + mapping kept (paid then pending)", trail[0].status === "paid" && trail[0].at === t1.toISOString() && trail[1].status === "pending");
  }

  await cleanup();
  savedSettings = await readSettings();

  // ── EDIT (DB) ─────────────────────────────────────────────────────────────
  {
    await putSetting("stock.alert_enabled", "true");
    await putSetting("stock.low_threshold_qty", "2");

    const pA = await mkProduct("a", 3);
    const pB = await mkProduct("b", 5);
    const pV = await mkProduct("v", 0, { product_type: "variable", shared_variant_stock: false, stock_qty: null });
    const vRed = await mkVariant(pV, "Rouge", 1);
    const order = await mkOrder("edit", "preparing", "cod");
    const itemA = await mkItem(order, pA, 1);
    await mkItem(order, pB, 1);
    const itemV = await mkItem(order, pV, 1, vRed);

    // A: 1→2 claims 1 → stock 3→2 = lands ON threshold 2 → low.
    resetCaptured();
    const r1 = await workflows.order.editItems({ orderId: order, ops: [{ kind: "set_qty", orderItemId: itemA, quantity: 2 }] }, { actorUserId: null });
    const lowA = lows.filter((e) => e.productId === pA);
    check("edit: growing a line ok", r1.ok === true);
    check("edit: 3→2 (threshold 2) → ONE product.stock_low, currentQty 2, threshold 2", lowA.length === 1 && lowA[0].currentQty === 2 && lowA[0].threshold === 2);
    check("edit: …carries the product labels (sku, name, no variant)", lowA[0]?.sku === `${TAG}-a` && lowA[0]?.name === `${TAG} a` && lowA[0]?.variantId === null);
    check("edit: …and no rupture yet", depleted.filter((e) => e.productId === pA).length === 0);

    // A: 2→4 claims 2 → stock 2→0 → depleted (already under the line: no second low).
    resetCaptured();
    await workflows.order.editItems({ orderId: order, ops: [{ kind: "set_qty", orderItemId: itemA, quantity: 4 }] }, { actorUserId: null });
    check("edit: 2→0 → ONE product.stock_depleted", depleted.filter((e) => e.productId === pA).length === 1);
    check("edit: …no repeated low alert under the threshold", lows.filter((e) => e.productId === pA).length === 0);

    // Variant (per-variant stock): 1→2 claims the variant's last unit → rupture on the VARIANT.
    resetCaptured();
    await workflows.order.editItems({ orderId: order, ops: [{ kind: "set_qty", orderItemId: itemV, quantity: 2 }] }, { actorUserId: null });
    const depV = depleted.filter((e) => e.productId === pV);
    check(
      "edit: variant rupture carries the VARIANT id, SKU and label",
      depV.length === 1 && depV[0].variantId === vRed && depV[0].sku === `${TAG}-Rouge` && depV[0].variantLabel === "Rouge",
    );

    // Removing A releases 4 units → sold-out 0 → 4 → product.restocked (back-in-stock).
    resetCaptured();
    const r4 = await workflows.order.editItems({ orderId: order, ops: [{ kind: "remove", orderItemId: itemA }] }, { actorUserId: null });
    check("edit: removing the line ok", r4.ok === true);
    check("edit: sold-out 0→4 release → ONE product.restocked", restocked.filter((e) => e.productId === pA).length === 1);

    // Toggle OFF: a crossing claim raises nothing, a sold-out release still restocks.
    await putSetting("stock.alert_enabled", "false");
    resetCaptured();
    await workflows.order.editItems({ orderId: order, ops: [{ kind: "set_qty", orderItemId: itemV, quantity: 1 }] }, { actorUserId: null });
    check("edit (alerts off): variant 0→1 release still fires product.restocked", restocked.filter((e) => e.productId === pV).length === 1);
    const pC = await mkProduct("c", 1);
    const itemC = await mkItem(order, pC, 1);
    resetCaptured();
    await workflows.order.editItems({ orderId: order, ops: [{ kind: "set_qty", orderItemId: itemC, quantity: 2 }] }, { actorUserId: null });
    check("edit (alerts off): a 1→0 claim raises NO rupture/low alert", depleted.filter((e) => e.productId === pC).length === 0 && lows.filter((e) => e.productId === pC).length === 0);

    await restoreSettings();
  }

  // ── PAID (DB) ─────────────────────────────────────────────────────────────
  {
    const T = workflows.order.transitionStatus;
    const forOrder = (id: string) => paid.filter((e) => e.orderId === id);

    const cod = await mkOrder("cod", "pending", "cod");
    for (const to of ["preparing", "shipped"] as const) await T({ orderId: cod, toStatus: to }, { actorUserId: null });
    check("paid: COD emits NO order.paid before delivery", forOrder(cod).length === 0);
    const d = await T({ orderId: cod, toStatus: "delivered" }, { actorUserId: null });
    check("paid: COD delivered ok + paid_at stamped", d.ok === true && (await paidAtOf(cod)) !== null);
    check("paid: COD delivery emits ONE order.paid, settledAt \"delivery\"", forOrder(cod).length === 1 && forOrder(cod)[0].settledAt === "delivery");

    const online = await mkOrder("flouci", "pending", "flouci");
    await T({ orderId: online, toStatus: "paid", paymentReference: `${TAG}-ref` }, { actorUserId: null });
    check("paid: online → paid emits order.paid, settledAt \"gateway\"", forOrder(online).length === 1 && forOrder(online)[0].settledAt === "gateway");
    for (const to of ["preparing", "shipped", "delivered"] as const) await T({ orderId: online, toStatus: to }, { actorUserId: null });
    check("paid: …its delivery does NOT emit a second order.paid", forOrder(online).length === 1);

    const cash = await mkOrder("cash", "pending", "cash");
    await T({ orderId: cash, toStatus: "paid" }, { actorUserId: null });
    check("paid: cash → paid emits order.paid, settledAt \"manual\"", forOrder(cash).length === 1 && forOrder(cash)[0].settledAt === "manual");
  }

  await cleanup();
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
