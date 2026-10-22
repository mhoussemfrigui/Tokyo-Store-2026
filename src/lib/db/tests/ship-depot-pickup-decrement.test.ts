import "server-only";

/**
 * ship-depot-decrement — the PICKUP depot drop (ISSUE-31 #1). In per_location +
 * `central` web-stock mode the selling DEPOT's physical `stock_levels` must fall
 * by the units that physically LEAVE it. Two paths already did this on a ship
 * (the BL parcel + the status-only "shipped"), but a PICKUP order (in-store /
 * drive-by) is COLLECTED, never shipped: it goes preparing → delivered directly
 * (orderTransitionsFor collapses `shipped` → `delivered` for a pickup method), so
 * NEITHER ship path fired and the depot level stayed high forever while the
 * cached total (dropped at placement) marched on — permanent drift.
 *
 * This exercises the REAL transition workflow + bus + subscriber:
 *   A  — a pickup (in_store / drive_by_pickup) order reaching `delivered`
 *        WITHOUT ever passing `shipped` drops the depot level ONCE (level-only,
 *        the cached total is untouched), ledgered as one `order` leg.
 *   B  — a home_delivery order (preparing → shipped → delivered) drops the depot
 *        at `shipped` and the new `delivered` handler must NOT double-count it
 *        (history shows `shipped`, so it skips).
 *
 * Self-cleaning (`__pickupdep…`; the two inventory settings are restored). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/ship-depot-pickup-decrement.test.ts
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  INVENTORY_LOCATION_MODE_KEY,
  INVENTORY_WEB_STOCK_SOURCE_KEY,
} from "@/lib/inventory/locations-config";
import { products } from "@/modules/catalog/product/schema";
import { orders, order_items } from "@/modules/order/schema";
import { order_returns, order_return_items } from "@/modules/order/returns.schema";
import { stock_levels } from "@/modules/stock-location/schema";
import { stockLocationService } from "@/modules/stock-location/service";
import { stock_movements } from "@/modules/stock-movement/schema";
import { registerAllSubscribers } from "@/events/subscribers";
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

const TAG = "__pickupdep";
const SETTING_KEYS = [INVENTORY_LOCATION_MODE_KEY, INVENTORY_WEB_STOCK_SOURCE_KEY] as const;
let savedSettings: Map<string, string | null> | null = null;

async function readSettings(): Promise<Map<string, string | null>> {
  const r = await db.execute(
    sql`select key, value from site_settings where key in (${INVENTORY_LOCATION_MODE_KEY}, ${INVENTORY_WEB_STOCK_SOURCE_KEY})`,
  );
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
    const prev = savedSettings.get(key);
    if (prev === undefined) {
      await db.execute(sql`delete from site_settings where key = ${key}`);
    } else {
      await db.execute(
        sql`insert into site_settings (key, value, label) values (${key}, ${prev}, ${TAG}) on conflict (key) do update set value = excluded.value`,
      );
    }
  }
}

async function cleanup() {
  await db.execute(sql`delete from order_return_items where return_id in (select r.id from order_returns r join orders o on o.id = r.order_id where o.order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from order_returns where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from shipment_items where shipment_id in (select s.id from shipments s join orders o on o.id = s.order_id where o.order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from shipments where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from order_items where order_id in (select id from orders where order_number like ${TAG + "%"})`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
  await db.execute(sql`delete from stock_movements where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from stock_levels where product_id in (select id from products where slug like ${TAG + "%"})`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

async function mkProduct(slug: string): Promise<string> {
  const [p] = await db
    .insert(products)
    .values({ slug: `${TAG}-${slug}`, name: `${TAG} ${slug}`, sku: `${TAG}-${slug}`, price_cents: 1000, stock_qty: 0, in_stock: true, is_published: true } as never)
    .returning({ id: products.id });
  return p.id;
}
async function mkOrder(tag: string, deliveryMethod: string): Promise<string> {
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-${tag}-${Date.now()}`,
      contact_email: "pd@example.test",
      status: "preparing",
      payment_method: "cod",
      delivery_method: deliveryMethod,
      subtotal_cents: 0,
      total_cents: 0,
      ship_full_name: "PD",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
    } as never)
    .returning({ id: orders.id });
  return o.id;
}
async function mkItem(orderId: string, productId: string, qty: number): Promise<string> {
  const [it] = await db
    .insert(order_items)
    .values({
      order_id: orderId,
      product_id: productId,
      variant_id: null,
      product_name: `${TAG} line`,
      product_slug: `${TAG}-line`,
      unit_price_cents: 1000,
      quantity: qty,
      subtotal_cents: 1000 * qty,
    } as never)
    .returning({ id: order_items.id });
  return it.id;
}
async function levelAt(productId: string, locationId: string): Promise<number> {
  const [r] = await db
    .select({ q: stock_levels.qty })
    .from(stock_levels)
    .where(and(eq(stock_levels.product_id, productId), eq(stock_levels.location_id, locationId), isNull(stock_levels.variant_id)));
  return r?.q ?? 0;
}
async function totalOf(productId: string): Promise<number | null> {
  const [r] = await db.select({ s: products.stock_qty }).from(products).where(eq(products.id, productId));
  return r?.s ?? null;
}
/** The per-location ledger legs of a given reason a product wrote at a location. */
async function legsAt(productId: string, locationId: string, reason: "order" | "return") {
  return db
    .select({ delta: stock_movements.delta })
    .from(stock_movements)
    .where(and(eq(stock_movements.product_id, productId), eq(stock_movements.reason, reason), eq(stock_movements.location_id, locationId)));
}

async function main() {
  await cleanup();
  savedSettings = await readSettings();

  // Opt into the depot-centric multi-location model the decrement lives in.
  await putSetting(INVENTORY_LOCATION_MODE_KEY, "per_location");
  await putSetting(INVENTORY_WEB_STOCK_SOURCE_KEY, "central");

  // The seeded default active location IS the selling depot (`depotIfPerLocation`
  // resolves it the same way).
  const depot = (await stockLocationService.listAll()).find((l) => l.is_default && l.is_active);
  if (!depot) throw new Error("test DB has no default active location to act as the depot");

  // Register the real subscriber set (idempotent via a globalThis guard — the
  // import side-effect already ran it, so this is a documented no-op). The
  // ship-depot-decrement subscriber is the unit under test; it must NOT be
  // registered a second time or every handler fires twice.
  registerAllSubscribers();

  const T = workflows.order.transitionStatus;

  // ── A: pickup collected (preparing → delivered, never shipped) ───────────────
  for (const method of ["in_store", "drive_by_pickup"] as const) {
    const p = await mkProduct(`pickup-${method}`);
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, depot.id, 5);
    check(`A[${method}]: setup — depot level 5, total 5`, (await levelAt(p, depot.id)) === 5 && (await totalOf(p)) === 5);

    const order = await mkOrder(`pk-${method}`, method);
    await mkItem(order, p, 2);

    const r = await T({ orderId: order, toStatus: "delivered" }, { actorUserId: null });
    check(`A[${method}]: transition preparing → delivered ok`, r.ok === true);
    check(`A[${method}]: depot level 5 → 3 (collected units left the depot)`, (await levelAt(p, depot.id)) === 3);
    check(`A[${method}]: cached TOTAL untouched at 5 (it moved at placement)`, (await totalOf(p)) === 5);
    const legs = await legsAt(p, depot.id, "order");
    check(`A[${method}]: exactly ONE order leg −2 at the depot`, legs.length === 1 && legs[0].delta === -2);
  }

  // ── B: home delivery (preparing → shipped → delivered) — no double-count ─────
  {
    const p = await mkProduct("home");
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, depot.id, 10);
    check("B: setup — depot level 10", (await levelAt(p, depot.id)) === 10);

    const order = await mkOrder("home", "home_delivery");
    await mkItem(order, p, 3);

    const rShip = await T({ orderId: order, toStatus: "shipped" }, { actorUserId: null });
    check("B: transition preparing → shipped ok", rShip.ok === true);
    check("B: depot level 10 → 7 at ship (status-only ship, no BL)", (await levelAt(p, depot.id)) === 7);

    const rDel = await T({ orderId: order, toStatus: "delivered" }, { actorUserId: null });
    check("B: transition shipped → delivered ok", rDel.ok === true);
    check("B: depot level STILL 7 — delivered did NOT double-decrement (shipped in history)", (await levelAt(p, depot.id)) === 7);
    const legs = await legsAt(p, depot.id, "order");
    check("B: exactly ONE order leg −3 at the depot (ship only)", legs.length === 1 && legs[0].delta === -3);
  }

  // ── C: a received RETURN credits the depot level back (ISSUE-31 #3) ──────────
  {
    const p = await mkProduct("return");
    await stockLocationService.setLocationLevel({ productId: p, variantId: null }, depot.id, 10);
    check("C: setup — depot level 10", (await levelAt(p, depot.id)) === 10);

    const order = await mkOrder("return", "home_delivery");
    const itemId = await mkItem(order, p, 3);

    const rShip = await T({ orderId: order, toStatus: "shipped" }, { actorUserId: null });
    check("C: transition preparing → shipped ok", rShip.ok === true);
    check("C: depot level 10 → 7 at ship", (await levelAt(p, depot.id)) === 7);

    const rCreate = await workflows.order.createReturn(
      { orderId: order, kind: "after_sale", lines: [{ orderItemId: itemId, quantity: 3, restockable: true }] },
      { actorUserId: null },
    );
    check("C: createReturn ok", rCreate.ok === true);
    const returnId = rCreate.ok ? rCreate.data.returnId : "";

    const rRecv = await workflows.order.receiveReturn({ returnId }, { actorUserId: null });
    check("C: receiveReturn ok (1 line restocked)", rRecv.ok === true && rRecv.data.restocked === 1);
    check("C: depot level 7 → 10 — the returned units are credited back to the depot", (await levelAt(p, depot.id)) === 10);
    const credit = await legsAt(p, depot.id, "return");
    check("C: exactly ONE return leg +3 at the depot", credit.length === 1 && credit[0].delta === 3);
  }

  await cleanup();
  await restoreSettings();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
      await restoreSettings();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
