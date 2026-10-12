import "server-only";

/**
 * Transaction pool re-entrancy guard (round-2 gap-hunt: gap-tx-pool-reentrancy-1/-2).
 *
 * The cancel (transitionOrderStatusWorkflow → cancelled) and full-refund
 * (refundOrderWorkflow) transactions used to make two POOL reads while their tx
 * held a connection plus the order/stock/promotion locks: the global shared-stock
 * default (restockOrderLines, on a cold cache) and the customer↔user link lookup
 * (niveau reconciliation). At pool-max concurrency every tx waited on a second
 * connection that never freed — pool deadlock until the acquire timeout.
 *
 * This process runs on a ONE-connection pool (injected via `globalThis.__gz_pool`
 * BEFORE @/lib/db/client loads) with a short acquire timeout, so a `db.*` call
 * nested in a `db.transaction` callback can't pass silently: it waits for the only
 * connection — held by that same tx — and fails (or, for a read with a stale
 * fallback, stalls for the full timeout, which the timing checks catch).
 *   H      — harness sanity: a pool read nested in a tx does fail on this pool.
 *   V1–V4  — getSharedStockDefault: a failed read with no prior success THROWS
 *            (never a silent "per-variant"); a later failure serves the last known
 *            value; a failure is never cached (the next call re-reads the DB).
 *   R1     — restockOrderLines given the pre-resolved `sharedDefault` makes no
 *            pool read inside the tx (cold cache).
 *   L1     — customerUserLink.findByUserId(userId, tx) runs on the tx.
 *   C1     — cancel of a paid signed-in order (cold cache): ok, fast, restocked.
 *   F1     — full refund of the same shape: ok, fast, restocked.
 *
 * Self-cleaning (`__txpool…`); restores the shared-stock app_secrets row. Run
 * (isolated DB):
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/tx-pool-reentrancy.test.ts
 */
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";

import { pgConnectionConfig } from "@/lib/db/ssl";

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

const TAG = "__txpool";
const U = `${TAG}-u1`;
// A nested acquire on the 1-connection pool waits exactly this long, then fails.
// Every guarded call must finish well inside it.
const ACQUIRE_TIMEOUT_MS = 2_000;

// Must be installed before @/lib/db/client is evaluated (it adopts
// `globalThis.__gz_pool` when set).
const pool = new Pool({
  ...pgConnectionConfig(process.env.DATABASE_URL ?? ""),
  max: 1,
  connectionTimeoutMillis: ACQUIRE_TIMEOUT_MS,
  application_name: "tokyo-tx-pool-test",
});
pool.on("error", (err) => console.error("[tx-pool-test] pool error", err));
globalThis.__gz_pool = pool;

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

async function main() {
  const { db } = await import("@/lib/db/client");
  const { bus } = await import("@/events/bus");
  const { products } = await import("@/modules/catalog/product/schema");
  const { orders, order_items } = await import("@/modules/order/schema");
  const { authService } = await import("@/modules/auth/service");
  const { customerService } = await import("@/modules/customer/service");
  const { customerUserLink } = await import("@/associations/customer-user.service");
  const { getSharedStockDefault, setSharedStockDefault, VARIANT_STOCK_SHARED_DEFAULT_KEY: KEY } =
    await import("@/lib/inventory/variant-stock");
  const { restockOrderLines } = await import("@/workflows/order/restock");
  const { workflows } = await import("@/workflows");
  // Only the tx bodies are under test — drop post-commit subscribers so their own
  // DB traffic can't blur the timing checks.
  bus.__reset();

  async function cleanup() {
    await db.execute(sql`delete from stock_movements where order_id in (select id from orders where order_number like ${TAG + "%"})`);
    await db.execute(sql`delete from order_refunds where order_id in (select id from orders where order_number like ${TAG + "%"})`);
    await db.execute(sql`delete from order_status_history where order_id in (select id from orders where order_number like ${TAG + "%"})`);
    await db.execute(sql`delete from order_items where order_id in (select id from orders where order_number like ${TAG + "%"})`);
    await db.execute(sql`delete from orders where order_number like ${TAG + "%"}`);
    await db.execute(sql`delete from products where slug like ${TAG + "%"}`);
    await db.execute(sql`delete from customer_user_links where user_id like ${TAG + "%"}`);
    await db.execute(sql`delete from customer_profiles where first_name = ${TAG}`);
    await db.execute(sql`delete from users where id like ${TAG + "%"}`);
  }

  async function stockOf(productId: string): Promise<number | null> {
    const [r] = await db.select({ s: products.stock_qty }).from(products).where(eq(products.id, productId));
    return r?.s ?? null;
  }

  async function mkProduct(slug: string, stock: number) {
    const [p] = await db
      .insert(products)
      .values({ slug: `${TAG}-${slug}`, name: `${TAG} ${slug}`, price_cents: 10_000, stock_qty: stock, in_stock: true, is_published: true } as never)
      .returning({ id: products.id });
    return p.id;
  }

  // A PAID (paid_at set) COD order of a signed-in customer — cancel and full
  // refund both run the promotion reconciliation + restock inside one tx.
  async function mkPaidOrder(tag: string, productId: string, qty: number) {
    const total = qty * 10_000;
    const [o] = await db
      .insert(orders)
      .values({
        order_number: `${TAG}-${tag}-${Date.now()}`,
        contact_email: `${U}@example.test`,
        user_id: U,
        status: "paid",
        payment_method: "cod",
        paid_at: new Date(),
        subtotal_cents: total,
        total_cents: total,
        ship_full_name: "TP",
        ship_street_line1: "1 rue",
        ship_city: "Tunis",
      } as never)
      .returning({ id: orders.id });
    await db.insert(order_items).values({
      order_id: o.id,
      product_id: productId,
      product_name: `${TAG} line`,
      product_slug: `${TAG}-line`,
      unit_price_cents: 10_000,
      quantity: qty,
      subtotal_cents: total,
    } as never);
    return o.id;
  }

  // Snapshot the shared-stock default row so it can be restored exactly.
  const priorRow = (await db.execute<{ value: string }>(sql`select value from app_secrets where key = ${KEY}`)).rows[0];
  const priorValue = ["true", "1", "on", "yes"].includes(priorRow?.value?.trim().toLowerCase() ?? "");

  // Hold the pool's only connection so every pool read fails with the acquire timeout.
  async function withPoolExhausted<T>(fn: () => Promise<T>): Promise<T> {
    const held = await pool.connect();
    try {
      return await fn();
    } finally {
      held.release();
    }
  }

  try {
    await cleanup();

    // ── V1: no successful read yet in this process + a failed read → THROWS ──
    // (was: silently `false` = per-variant, and CACHED for 15 s).
    let v1Err: unknown = null;
    await withPoolExhausted(async () => {
      try {
        await getSharedStockDefault();
      } catch (err) {
        v1Err = err;
      }
    });
    check("V1: a failed read with no last-known value throws (no silent per-variant)", v1Err !== null);

    // ── V2: the next call (pool free) reads the real value — the failure wasn't cached ──
    check("V2: after a failed read the next call re-reads the DB value", (await getSharedStockDefault()) === priorValue);

    // ── V3: a later failure (cache cold, last value known) serves the last value ──
    // The setter busts the cache and records the value it wrote.
    await setSharedStockDefault(priorValue);
    let v3: boolean | null = null;
    let v3Err: unknown = null;
    await withPoolExhausted(async () => {
      try {
        v3 = await getSharedStockDefault();
      } catch (err) {
        v3Err = err;
      }
    });
    check("V3: a failed refresh serves the last known value (no throw)", v3Err === null && v3 === priorValue);

    // ── V4: that stale fallback was NOT cached — flip the row behind the setter's
    // back: the next call must see the flip. ──
    await db.execute(sql`update app_secrets set value = ${priorValue ? "false" : "true"} where key = ${KEY}`);
    check("V4: a failed read is never cached (next call reads the flipped row)", (await getSharedStockDefault()) === !priorValue);
    await setSharedStockDefault(priorValue); // restore + cold cache

    // ── H: harness sanity — a pool read nested in a tx fails on this pool ──
    let hErr: unknown = null;
    const h = await timed(async () => {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql`select 1`);
          await db.execute(sql`select 1`); // second connection while tx holds the only one
        });
      } catch (err) {
        hErr = err;
      }
    });
    check("H: a pool read nested in a tx fails (acquire timeout) on the 1-connection pool", hErr !== null && h.ms >= ACQUIRE_TIMEOUT_MS - 100);

    // ── Fixture: a signed-in customer with coins ──
    await authService.insert({ id: U, email: `${U}@example.test`, name: U, role: "customer" } as never);
    const profile = await customerService.insertProfile({
      first_name: TAG,
      last_name: "Tester",
    });
    await customerUserLink.create({ customer_profile_id: profile.id, user_id: U } as never);

    // ── L1: the link lookup runs on the caller's tx ──
    let l1Link: Awaited<ReturnType<typeof customerUserLink.findByUserId>> = null;
    let l1Err: unknown = null;
    const l1 = await timed(async () => {
      try {
        await db.transaction(async (tx) => {
          l1Link = await customerUserLink.findByUserId(U, tx);
        });
      } catch (err) {
        l1Err = err;
      }
    });
    check(
      "L1: findByUserId(userId, tx) resolves the link on the tx (no second connection)",
      l1Err === null && (l1Link as { customer_profile_id?: string } | null)?.customer_profile_id === profile.id && l1.ms < ACQUIRE_TIMEOUT_MS,
    );

    // ── R1: restock with the pre-resolved default makes no pool read (cold cache) ──
    {
      const p = await mkProduct("r1", 5);
      const o = await mkPaidOrder("r1", p, 2);
      await setSharedStockDefault(priorValue); // cold cache
      let rErr: unknown = null;
      const r = await timed(async () => {
        try {
          await db.transaction(async (tx) => {
            await restockOrderLines(tx, o, "cancellation", null, { sharedDefault: priorValue });
          });
        } catch (err) {
          rErr = err;
        }
      });
      check("R1: restockOrderLines(…, { sharedDefault }) runs entirely on the tx", rErr === null && r.ms < ACQUIRE_TIMEOUT_MS);
      check("R1: …and restocked the line (5 → 7)", (await stockOf(p)) === 7);
    }

    // ── C1: cancel (cold shared-stock cache) runs on one connection + restocks ──
    {
      const p = await mkProduct("c1", 5);
      const o = await mkPaidOrder("c1", p, 2);
      await setSharedStockDefault(priorValue); // cold cache
      const c = await timed(() => workflows.order.transitionStatus({ orderId: o, toStatus: "cancelled" }, { actorUserId: null }));
      check("C1: cancel of a paid signed-in order succeeds on the 1-connection pool", c.value.ok === true);
      check("C1: …without stalling on a nested pool acquire", c.ms < ACQUIRE_TIMEOUT_MS);
      check("C1: …restocked the line (5 → 7)", (await stockOf(p)) === 7);
    }

    // ── F1: full refund (cold shared-stock cache) runs on one connection + restocks ──
    {
      const p = await mkProduct("f1", 5);
      const o = await mkPaidOrder("f1", p, 2);
      await setSharedStockDefault(priorValue); // cold cache
      const f = await timed(() => workflows.order.refund({ orderId: o, amountCents: 20_000 }, { actorUserId: `${TAG}-actor` }));
      check("F1: full refund of a paid signed-in order succeeds on the 1-connection pool", f.value.ok === true);
      check("F1: …without stalling on a nested pool acquire", f.ms < ACQUIRE_TIMEOUT_MS);
      check("F1: …restocked the unshipped line (5 → 7)", (await stockOf(p)) === 7);
    }
  } finally {
    // Restore the shared-stock default row exactly (absent → delete).
    if (priorRow) {
      await db.execute(sql`update app_secrets set value = ${priorRow.value} where key = ${KEY}`);
    } else {
      await db.execute(sql`delete from app_secrets where key = ${KEY}`);
    }
    await cleanup();
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
