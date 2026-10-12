import "server-only";

/**
 * Admin dashboard / Statistiques / Commandes KPI consistency (A–Z 2026-09-23,
 * unit p3-dashboard-kpis). Pins, against a real Postgres:
 *   1. the dashboard RBAC matrix (`resolveDashboardAccess`) — a scoped delegate
 *      never gets another module's data; `dashboard:view` is the master switch;
 *   2. the ONE revenue base (`revenueOrderSql` + `netOrderCentsSql`): settled,
 *      not cancelled/refunded, NET of refunds — row-level and through
 *      `orderService.stats()`, `getDailyOrdersSeries`, `getPaymentMethodBreakdown`;
 *   3. the ONE « À traiter » rule: `actionableOrderSql` ⇔ `isActionableOrder`
 *      (pending COD counts, an unpaid online checkout doesn't) + `stats().actionable`;
 *   4. top sellers rank on the NUMERIC quantity (9/45/100/12 — the old text
 *      sort gave 9 > 45 > 12 > 100) and a renamed product stays ONE row;
 *   5. the stock-state predicates: the configured low threshold, a tracked qty 0
 *      left « Disponible » is « Rupture » (not invisible to both filters), and
 *      the dashboard count equals the stock page's `?filter=low` total.
 * Global aggregates are asserted as before/after deltas; when another test
 * writes orders concurrently (total delta ≠ ours) the exact-delta checks fall
 * back to lower bounds. Self-cleaning (`__kpit…`).
 *
 * Run (isolated DB only):
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/dashboard-kpis.test.ts
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { order_items, order_refunds, orders } from "@/modules/order/schema";
import { products } from "@/modules/catalog/product/schema";
import { orderService } from "@/modules/order/service";
import {
  actionableOrderSql,
  getDailyOrdersSeries,
  getPaymentMethodBreakdown,
  getTopSellingProducts,
  netOrderCentsSql,
  revenueOrderSql,
} from "@/modules/order/queries";
import { productService } from "@/modules/catalog/product/service";
import { productQueries } from "@/modules/catalog/product";
import { isActionableOrder } from "@/lib/order/status";
import { permissionSetAllows } from "@/lib/rbac/authorize";
import { resolveDashboardAccess } from "@/lib/rbac/dashboard-access";

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

const TAG = "__kpit";
const DAY = 86_400_000;

async function cleanup() {
  const mine = sql`(select id from orders where order_number like ${TAG + "%"})`;
  await db.execute(sql`delete from order_refunds where order_id in ${mine}`);
  await db.execute(sql`delete from order_status_history where order_id in ${mine}`);
  await db.execute(sql`delete from order_items where order_id in ${mine}`);
  await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
  await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
}

type Seed = {
  key: string;
  status: "pending" | "paid" | "preparing" | "shipped" | "delivered" | "cancelled" | "refunded";
  method: "cod" | "flouci" | "clictopay" | null;
  paid: boolean;
  total: number;
  refund?: number;
  createdAt?: Date;
};

async function mkOrder(s: Seed): Promise<string> {
  const [row] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}-${s.key}-${Date.now()}`,
      contact_email: "kpit@example.com",
      status: s.status,
      payment_method: s.method,
      paid_at: s.paid ? new Date() : null,
      subtotal_cents: s.total,
      total_cents: s.total,
      ship_full_name: "KPI Test",
      ship_street_line1: "1 rue",
      ship_city: "Tunis",
      ...(s.createdAt ? { created_at: s.createdAt } : {}),
    } as never)
    .returning({ id: orders.id });
  if (s.refund) {
    await db.insert(order_refunds).values({ order_id: row.id, amount_cents: s.refund } as never);
  }
  return row.id;
}

async function mkLine(orderId: string, productId: string, name: string, qty: number, subtotal: number) {
  await db.insert(order_items).values({
    order_id: orderId,
    product_id: productId,
    product_name: name,
    product_slug: `${TAG}-${name}`,
    unit_price_cents: Math.round(subtotal / qty),
    quantity: qty,
    subtotal_cents: subtotal,
  } as never);
}

async function mkProduct(
  slug: string,
  o: { qty: number | null; inStock: boolean; published?: boolean },
): Promise<string> {
  const [p] = await db
    .insert(products)
    .values({
      slug: `${TAG}-${slug}`,
      name: `${TAG} ${slug}`,
      price_cents: 10_000,
      stock_qty: o.qty,
      in_stock: o.inStock,
      is_published: o.published ?? true,
      product_type: "simple",
    } as never)
    .returning({ id: products.id });
  return p.id;
}

/** Re-run a pair of global reads until they agree (a concurrent writer can land
 *  between them) — up to 3 tries; returns the last pair. */
async function stablePair(a: () => Promise<number>, b: () => Promise<number>) {
  let pair: [number, number] = [0, 0];
  for (let i = 0; i < 3; i++) {
    pair = [await a(), await b()];
    if (pair[0] === pair[1]) break;
  }
  return pair;
}

function accessMatrix() {
  console.log("dashboard RBAC matrix:");
  const acc = (...grants: string[]) => {
    const perms = new Set(grants);
    return resolveDashboardAccess((m, a) => permissionSetAllows(perms, m, a));
  };
  const star = acc("*");
  check(
    "wildcard sees every block + the create button",
    star.revenue && star.orders && star.customers && star.stock && star.stockPage && star.productPages && star.createProduct && star.any,
  );
  const blog = acc("blog_posts:*");
  check("blog-only delegate: no data block at all (welcome card)", !blog.any && !blog.revenue && !blog.orders && !blog.customers && !blog.stock);
  check("blog-only delegate: no « Nouveau produit »", !blog.createProduct);
  check("orders:view WITHOUT dashboard:view → no order data on /admin", !acc("orders:view").orders);
  check("dashboard:view alone → nothing (each block needs its module grant)", !acc("dashboard:view").any);
  const ops = acc("dashboard:view", "orders:view");
  check("dashboard + orders → orders block (emails) only", ops.orders && !ops.revenue && !ops.customers && !ops.stock);
  const fin = acc("dashboard:view", "analytics:view");
  check("dashboard + analytics → revenue only, no recent-order emails", fin.revenue && !fin.orders);
  check("dashboard + customers → customers block", acc("dashboard:view", "customers:view").customers);
  const stk = acc("dashboard:view", "stock:view");
  check("dashboard + stock:view → stock card + « Tout voir », no product links", stk.stock && stk.stockPage && !stk.productPages);
  const prd = acc("dashboard:view", "products:view");
  check("dashboard + products:view → stock card + product links, no stock page link", prd.stock && !prd.stockPage && prd.productPages);
  check("module wildcards honoured (dashboard:* + analytics:*)", acc("dashboard:*", "analytics:*").revenue);
  const creator = acc("products:create");
  check("products:create alone → button, but no data", creator.createProduct && !creator.any);
  check("wildcard sees the reviews tile", star.reviews);
  const rev = acc("dashboard:view", "reviews:view");
  check("dashboard + reviews:view → reviews tile only", rev.reviews && rev.any && !rev.orders && !rev.revenue && !rev.stock);
  check("reviews:view WITHOUT dashboard:view → no reviews tile", !acc("reviews:view").reviews && !acc("reviews:view").any);
  check("dashboard:view alone → no reviews tile", !acc("dashboard:view").reviews);
}

async function revenueAndQueue() {
  console.log("revenue base + « À traiter »:");
  const seeds: Seed[] = [
    // settled, partially refunded → counts at 100 000 − 30 000
    { key: "A", status: "delivered", method: "cod", paid: true, total: 100_000, refund: 30_000 },
    // settled online, awaiting prep → revenue + actionable
    { key: "B", status: "paid", method: "flouci", paid: true, total: 50_000 },
    // paid then cancelled — paid_at survives, must NOT count
    { key: "C", status: "cancelled", method: "flouci", paid: true, total: 80_000 },
    // fully refunded — must NOT count
    { key: "D", status: "refunded", method: "clictopay", paid: true, total: 60_000, refund: 60_000 },
    // new COD order awaiting prep → actionable, not revenue
    { key: "E", status: "pending", method: "cod", paid: false, total: 40_000 },
    // unpaid online checkout → neither
    { key: "F", status: "pending", method: "flouci", paid: false, total: 20_000 },
    // COD in preparation (unpaid until delivery) → actionable, not revenue
    { key: "G", status: "preparing", method: "cod", paid: false, total: 30_000 },
    // pending with no method (COD graph) → actionable
    { key: "H", status: "pending", method: null, paid: false, total: 10_000 },
  ];
  const expectRevenue = 70_000 + 50_000;
  const expectPaid = 2;
  const expectActionable = 4; // B, E, G, H

  const before = await orderService.stats();
  const seriesBefore = await getDailyOrdersSeries(2);
  const payBefore = await getPaymentMethodBreakdown(2);
  for (const s of seeds) await mkOrder(s);
  const after = await orderService.stats();
  const seriesAfter = await getDailyOrdersSeries(2);
  const payAfter = await getPaymentMethodBreakdown(2);

  // Row-level: the SQL fragments agree with the JS rule on every seeded order.
  const rows = await db.execute<{
    order_number: string;
    status: string;
    payment_method: string | null;
    paid_at: string | null;
    act: boolean;
    rev: boolean;
    net: string;
  }>(sql`
    SELECT o.order_number, o.status, o.payment_method, o.paid_at,
           ${actionableOrderSql("o")} AS act,
           ${revenueOrderSql("o")} AS rev,
           ${netOrderCentsSql("o")}::text AS net
    FROM ${orders} o WHERE o.order_number LIKE ${TAG + "%"}
  `);
  const byKey = new Map(rows.rows.map((r) => [r.order_number.split("-")[1], r]));
  check("all 8 seeded orders read back", byKey.size === 8);
  for (const r of rows.rows) {
    check(
      `actionableOrderSql ⇔ isActionableOrder (${r.order_number.split("-")[1]}: ${r.status}/${r.payment_method})`,
      r.act === isActionableOrder(r.status, r.payment_method, r.paid_at),
    );
  }
  check("revenue base = exactly A + B", [...byKey].filter(([, r]) => r.rev).map(([k]) => k).sort().join() === "A,B");
  check("net value nets the partial refund (A = 70 000)", byKey.get("A")?.net === "70000");
  check("net value nets a full refund (D = 0)", byKey.get("D")?.net === "0");

  // Through the real aggregates.
  const quiet = after.total - before.total === seeds.length;
  if (!quiet) console.log("  · concurrent order writes detected — exact deltas relaxed to lower bounds");
  const dRev = after.revenueCents - before.revenueCents;
  const dPaid = after.paid - before.paid;
  const dAct = after.actionable - before.actionable;
  check(`stats().revenueCents +${expectRevenue} (net, no cancelled/refunded)`, quiet ? dRev === expectRevenue : after.revenueCents >= expectRevenue);
  check(`stats().paid +${expectPaid} (paid_at set, not cancelled/refunded)`, quiet ? dPaid === expectPaid : after.paid >= expectPaid);
  check(`stats().actionable +${expectActionable} (pending COD in, unpaid online out)`, quiet ? dAct === expectActionable : after.actionable >= expectActionable);

  const todayB = seriesBefore[seriesBefore.length - 1];
  const todayA = seriesAfter[seriesAfter.length - 1];
  check("daily series: 2 rows for days=2", seriesAfter.length === 2);
  check(
    "daily series today: +2 paid orders, +120 000 net",
    quiet
      ? todayA.count - todayB.count === 2 && todayA.revenueCents - todayB.revenueCents === expectRevenue
      : todayA.count >= 2 && todayA.revenueCents >= expectRevenue,
  );

  const pay = (rows: Awaited<ReturnType<typeof getPaymentMethodBreakdown>>, m: string) =>
    rows.find((r) => r.method === m) ?? { method: m, orders: 0, revenueCents: 0 };
  const dCod = pay(payAfter, "cod").revenueCents - pay(payBefore, "cod").revenueCents;
  const dFlouci = pay(payAfter, "flouci").revenueCents - pay(payBefore, "flouci").revenueCents;
  const dCtp = pay(payAfter, "clictopay").revenueCents - pay(payBefore, "clictopay").revenueCents;
  check("encaissements: COD +70 000 (refund netted)", quiet ? dCod === 70_000 : pay(payAfter, "cod").revenueCents >= 70_000);
  check("encaissements: Flouci +50 000 (cancelled one excluded)", quiet ? dFlouci === 50_000 : pay(payAfter, "flouci").revenueCents >= 50_000);
  check("encaissements: ClicToPay +0 (refunded order excluded)", quiet ? dCtp === 0 : true);
}

async function topSellers() {
  console.log("top sellers:");
  const p9 = randomUUID();
  const p45 = randomUUID();
  const p100 = randomUUID();
  const p12hi = randomUUID();
  const p12lo = randomUUID();
  // Older order carries p45's OLD name; the newer one its new name.
  const older = await mkOrder({
    key: "T1", status: "delivered", method: "cod", paid: true, total: 1,
    createdAt: new Date(Date.now() - 2 * DAY),
  });
  const newer = await mkOrder({ key: "T2", status: "delivered", method: "cod", paid: true, total: 1 });
  await mkLine(older, p45, "kpit-old-name", 40, 40_000);
  await mkLine(newer, p45, "kpit-new-name", 5, 5_000);
  await mkLine(newer, p9, "kpit-nine", 9, 9_000);
  await mkLine(newer, p100, "kpit-hundred", 100, 100_000);
  await mkLine(newer, p12hi, "kpit-twelve-hi", 12, 24_000);
  await mkLine(newer, p12lo, "kpit-twelve-lo", 12, 12_000);

  const top = await getTopSellingProducts(500, 90);
  const mineIds = new Set<string>([p9, p45, p100, p12hi, p12lo]);
  const mine = top.filter((t) => mineIds.has(t.productId));
  const idx = new Map<string, string>([[p100, "100"], [p45, "45"], [p12hi, "12hi"], [p12lo, "12lo"], [p9, "9"]]);
  const order = mine.map((t) => idx.get(t.productId)).join(" > ");
  check(`numeric rank 100 > 45 > 12hi > 12lo > 9 (got ${order})`, order === "100 > 45 > 12hi > 12lo > 9");
  const row45 = mine.filter((t) => t.productId === p45);
  check("renamed product is ONE row", row45.length === 1);
  check("renamed product sums both names (45)", row45[0]?.quantity === 45);
  check("renamed product labelled with its latest name", row45[0]?.productName === "kpit-new-name");
  check("row 0 of a top-N holds the max (bar scaling)", top.every((t) => t.quantity <= (top[0]?.quantity ?? 0)));
}

async function stockStates() {
  console.log("stock states:");
  const ids = {
    l1: await mkProduct("l1", { qty: 1, inStock: true }),
    l3: await mkProduct("l3", { qty: 3, inStock: true }),
    l4: await mkProduct("l4", { qty: 4, inStock: true }),
    zero: await mkProduct("zero", { qty: 0, inStock: true }), // tracked 0 left « Disponible »
    off: await mkProduct("off", { qty: 2, inStock: false }),
    untracked: await mkProduct("untracked", { qty: null, inStock: true }),
    draft2: await mkProduct("draft2", { qty: 2, inStock: true, published: false }),
  };
  const nameOf = new Map(Object.entries(ids).map(([k, v]) => [v, k]));
  const paged = async (filter: string, lowThreshold?: number) =>
    (await productService.listStockPaged({ search: TAG, filter, lowThreshold, pageSize: 200 })).items
      .map((p) => nameOf.get(p.id))
      .filter(Boolean)
      .sort()
      .join(",");

  check("low @3 = l1, l3 + the draft (stock page lists drafts too)", (await paged("low", 3)) === "draft2,l1,l3");
  check("low default threshold (5) also takes l4", (await paged("low")) === "draft2,l1,l3,l4");
  check("low @0 = tier disabled", (await paged("low", 0)) === "");
  check("Rupture = unticked + tracked-0-left-Disponible", (await paged("out_of_stock", 3)) === "off,zero");
  check("En stock excludes the tracked 0", (await paged("in_stock", 3)) === "draft2,l1,l3,l4,untracked");
  check("Non suivi = untracked", (await paged("none", 3)) === "untracked");

  const dash = (await productQueries.listLowStockProducts({ threshold: 3, limit: 20 }))
    .map((p) => nameOf.get(p.id))
    .filter(Boolean)
    .sort()
    .join(",");
  check("dashboard rows use the SAME low predicate as ?filter=low", dash === "draft2,l1,l3");

  const [lowCount, lowTotal] = await stablePair(
    () => productQueries.countStockProducts("low", 3),
    async () => (await productService.listStockPaged({ filter: "low", lowThreshold: 3 })).total,
  );
  check(`dashboard low count = stock page ?filter=low total (${lowCount} = ${lowTotal})`, lowCount === lowTotal);
  const [outCount, outTotal] = await stablePair(
    () => productQueries.countStockProducts("out_of_stock", 3),
    async () => (await productService.listStockPaged({ filter: "out_of_stock", lowThreshold: 3 })).total,
  );
  check(`dashboard rupture count = stock page ?filter=out_of_stock total (${outCount} = ${outTotal})`, outCount === outTotal);
}

async function main() {
  await cleanup();
  accessMatrix();
  await revenueAndQueue();
  await topSellers();
  await stockStates();
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
