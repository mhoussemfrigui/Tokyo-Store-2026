import "server-only";

/**
 * Orders admin read-model regressions (A–Z 2026-09-23, p4-orders-admin):
 *
 *   A. LIST — `orderService.list` pages on a µs `(created_at, id)` DESC keyset
 *      (orders sharing ONE timestamp are neither skipped nor repeated; a
 *      malformed cursor falls back to page 1) and filters SERVER-side by status,
 *      the « À traiter » queue (pending COD / paid / preparing, NOT an unpaid
 *      online checkout) and « a un retour »; `listFilterCounts` gives the chip
 *      counts over the whole store under the same search.
 *   B. CUSTOMER 360 — `listOrdersForUserOrEmail` / `getUserOrderSummary` match
 *      the account's orders + GUEST orders under its email, never another
 *      account's order merely typed with that address.
 *   C. SAV PHONE LOOKUP — `listOrdersByPhone` matches the last 8 digits, so
 *      « +216 … », « 00216 … » and the local 8-digit form find each other.
 *   D. PICK TOGGLE — `setItemPicked` is scoped to its order (a foreign line id
 *      matches nothing).
 *   E. WARRANTY / RETURNS HUB — `deliveredAtByOrder` (first delivery),
 *      `countPendingReturns` (not windowed) and `listReturnCommentsSince`
 *      (window-scoped, blank comments excluded).
 *
 * Self-cleaning (`__oadmtest…` contact emails). Writes fixture orders — run it
 * ONLY against a throwaway test DB:
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… pnpm exec tsx --conditions=react-server \
 *     src/lib/db/tests/orders-admin.test.ts
 */
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { order_items, order_status_history, orders, type NewOrderRow } from "@/modules/order/schema";
import { order_returns } from "@/modules/order/returns.schema";
import { orderService } from "@/modules/order/service";
import {
  countPendingReturns,
  deliveredAtByOrder,
  getUserOrderSummary,
  listOrdersByPhone,
  listOrdersForUserOrEmail,
  listReturnCommentsSince,
} from "@/modules/order/queries";

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

const RUN = randomUUID().slice(0, 8);
const TAG = `__oadmtest${RUN}`;
const mail = (s: string) => `${TAG}-${s}@example.test`;
/** A random 8-digit national number (starts with 9 — never collides with the demo data's 2x/5x). */
const NATIONAL = `9${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;

let seq = 0;
async function makeOrder(patch: Partial<NewOrderRow> & { contact_email: string }) {
  seq++;
  return orderService.insertOrder({
    order_number: `${TAG}-${seq}`,
    subtotal_cents: 10_000,
    total_cents: 10_000,
    ship_full_name: "Test",
    ship_street_line1: "1 rue du Lac",
    ship_city: "Tunis",
    ...patch,
  });
}

async function cleanup() {
  const mine = sql`(select id from orders where contact_email like ${TAG + "%"})`;
  await db.execute(sql`delete from order_returns where order_id in ${mine}`);
  await db.execute(sql`delete from order_status_history where order_id in ${mine}`);
  await db.execute(sql`delete from order_items where order_id in ${mine}`);
  await db.delete(orders).where(like(orders.contact_email, `${TAG}%`));
}

// ── A. list keyset + server filters + chip counts ────────────────────────────
async function listAndCounts() {
  console.log("A. admin list — keyset paging, server filters, chip counts");
  const search = `${TAG}-list`;
  // Six orders sharing ONE µs timestamp — the boundary a ms-only cursor skipped.
  const at = sql`'2026-01-15T10:00:00.123456Z'::timestamptz`;
  const specs: Array<Partial<NewOrderRow>> = [
    { status: "pending", payment_method: "cod" }, // actionable (COD waits in pending)
    { status: "pending", payment_method: "flouci" }, // NOT actionable (unpaid online)
    { status: "paid", payment_method: "flouci", paid_at: new Date() }, // actionable
    { status: "preparing", payment_method: "cod" }, // actionable
    { status: "delivered", payment_method: "cod", paid_at: new Date() },
    { status: "cancelled", payment_method: "cod" },
  ];
  const created = [];
  for (const [i, s] of specs.entries()) {
    created.push(await makeOrder({ ...s, contact_email: mail(`list${i}`), created_at: at as never }));
  }
  const withReturn = created[4];
  await db.insert(order_returns).values({ order_id: withReturn.id, status: "received" });

  // Keyset walk, 2 per page.
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const page = await orderService.list({ search, limit: 2, cursor });
    pages++;
    seen.push(...page.items.map((o) => o.id));
    if (!page.nextCursor || pages > 10) break;
    cursor = page.nextCursor;
  }
  check(`keyset walk returns all 6 same-timestamp orders (got ${seen.length})`, seen.length === 6);
  check("no order repeated across pages", new Set(seen).size === seen.length);
  check("3 pages of 2", pages === 3);
  check(
    "cursor is µs-faithful (`<ts .ffffff>|<uuid>`)",
    (await orderService.list({ search, limit: 2 })).nextCursor?.includes(".123456Z|") === true,
  );
  const junk = await orderService.list({ search, limit: 2, cursor: "not-a-date|nope" });
  check("malformed cursor → first page (no 22007)", junk.items.length === 2 && junk.items[0].id === seen[0]);

  const delivered = await orderService.list({ search, status: "delivered" });
  check(
    "status filter is server-side",
    delivered.items.length === 1 && delivered.items[0].id === created[4].id,
  );
  const queue = await orderService.list({ search, actionable: true });
  const queueIds = new Set(queue.items.map((o) => o.id));
  check(
    "« À traiter » = pending COD + paid + preparing (3), not the unpaid online checkout",
    queue.items.length === 3 &&
      queueIds.has(created[0].id) &&
      queueIds.has(created[2].id) &&
      queueIds.has(created[3].id) &&
      !queueIds.has(created[1].id),
  );
  const returns = await orderService.list({ search, hasReturn: true });
  check("« Retours » filter = orders with a return", returns.items.length === 1 && returns.items[0].id === withReturn.id);

  const counts = await orderService.listFilterCounts({ search });
  check(`chip counts: total 6 (got ${counts.total})`, counts.total === 6);
  check(
    "chip counts per status",
    counts.byStatus.pending === 2 &&
      counts.byStatus.paid === 1 &&
      counts.byStatus.preparing === 1 &&
      counts.byStatus.delivered === 1 &&
      counts.byStatus.cancelled === 1 &&
      counts.byStatus.shipped === undefined,
  );
  check("chip counts: actionable 3, withReturn 1", counts.actionable === 3 && counts.withReturn === 1);
}

// ── B. customer 360 ──────────────────────────────────────────────────────────
async function customer360() {
  console.log("B. customer 360 — own orders + own-email GUEST orders only");
  const userA = `${TAG}-userA`;
  const userB = `${TAG}-userB`;
  const mailB = mail("b");
  const own = await makeOrder({ contact_email: mailB, user_id: userB, total_cents: 1_000, subtotal_cents: 1_000 });
  const guest = await makeOrder({ contact_email: mailB.toUpperCase(), total_cents: 2_000, subtotal_cents: 2_000 });
  const foreign = await makeOrder({ contact_email: mailB, user_id: userA, total_cents: 4_000, subtotal_cents: 4_000 });

  const listB = new Set((await listOrdersForUserOrEmail(userB, mailB)).map((o) => o.id));
  check("B's 360 lists B's own order", listB.has(own.id));
  check("B's 360 lists the guest order placed under B's email (case-insensitive)", listB.has(guest.id));
  check("B's 360 does NOT list account A's order typed with B's email", !listB.has(foreign.id));
  const sumB = await getUserOrderSummary(userB, mailB);
  check(
    `B's KPIs exclude A's order (count 2 / spend 3000 — got ${sumB.orderCount} / ${sumB.lifetimeSpendCents})`,
    sumB.orderCount === 2 && sumB.lifetimeSpendCents === 3_000,
  );
  const listA = new Set((await listOrdersForUserOrEmail(userA, mail("a"))).map((o) => o.id));
  check("A's 360 keeps A's order whatever email it carries", listA.has(foreign.id) && !listA.has(guest.id));
  const noAccount = new Set((await listOrdersForUserOrEmail(null, mailB)).map((o) => o.id));
  check("no account → plain email match (profile-only view unchanged)", noAccount.has(guest.id));
}

// ── C. SAV phone lookup ──────────────────────────────────────────────────────
async function phoneLookup() {
  console.log(`C. warranty phone lookup — last 8 digits (${NATIONAL})`);
  const spaced = `${NATIONAL.slice(0, 2)} ${NATIONAL.slice(2, 5)} ${NATIONAL.slice(5)}`;
  const intl = await makeOrder({ contact_email: mail("ph1"), contact_phone: `+216 ${spaced}` });
  const local = await makeOrder({ contact_email: mail("ph2"), contact_phone: spaced });
  const ids = async (q: string) => new Set((await listOrdersByPhone(q)).map((o) => o.id));

  const byLocal = await ids(NATIONAL);
  check("local 8 digits finds the +216 order AND the local one", byLocal.has(intl.id) && byLocal.has(local.id));
  const byIntl = await ids(`+216${NATIONAL}`);
  check("+216 form finds the locally-typed order", byIntl.has(local.id) && byIntl.has(intl.id));
  const byZeros = await ids(`00216 ${spaced}`);
  check("00216 form finds both", byZeros.has(local.id) && byZeros.has(intl.id));
  const partial = await ids(NATIONAL.slice(-5));
  check("a shorter entry keeps the exact digits match (no suffix fishing)", !partial.has(local.id) && !partial.has(intl.id));
}

// ── D. pick toggle scoping ───────────────────────────────────────────────────
async function pickScope() {
  console.log("D. setItemPicked is scoped to its order");
  const x = await makeOrder({ contact_email: mail("pickx") });
  const y = await makeOrder({ contact_email: mail("picky") });
  const [item] = await orderService.insertItems([
    {
      order_id: x.id,
      product_id: randomUUID(),
      product_name: "Montre test",
      product_slug: `${TAG}-montre`,
      unit_price_cents: 10_000,
      quantity: 1,
      subtotal_cents: 10_000,
    },
  ]);
  const foreign = await orderService.setItemPicked(y.id, item.id, true);
  const [afterForeign] = await db.select().from(order_items).where(eq(order_items.id, item.id));
  check("line of order X via order Y → null, not stamped", foreign === null && afterForeign.picked_at === null);
  const own = await orderService.setItemPicked(x.id, item.id, true);
  const [afterOwn] = await db.select().from(order_items).where(eq(order_items.id, item.id));
  check("line via its own order → stamped", own === x.id && afterOwn.picked_at !== null);
}

// ── E. warranty delivery date + returns hub reads ────────────────────────────
async function warrantyAndReturnsHub() {
  console.log("E. first delivery date + returns hub (pending not windowed, comments in window)");
  const o = await makeOrder({ contact_email: mail("dlv"), status: "delivered" });
  const never = await makeOrder({ contact_email: mail("nodlv") });
  const first = new Date("2026-02-01T09:00:00Z");
  await db.insert(order_status_history).values([
    { order_id: o.id, from_status: "shipped", to_status: "delivered", created_at: first },
    { order_id: o.id, from_status: "refunded", to_status: "delivered", created_at: new Date("2026-03-01T09:00:00Z") },
  ]);
  const map = await deliveredAtByOrder([o.id, never.id]);
  check("deliveredAtByOrder = the FIRST delivery", map.get(o.id)?.getTime() === first.getTime());
  check("never-delivered order is absent", !map.has(never.id));

  const before = await countPendingReturns();
  const old = new Date(Date.now() - 400 * 24 * 3600 * 1000);
  await db.insert(order_returns).values({ order_id: o.id, status: "pending", created_at: old });
  check("a 400-day-old pending return still counts as « à traiter »", (await countPendingReturns()) >= before + 1);

  const recent = await makeOrder({ contact_email: mail("cmt") });
  const [withNote] = await db
    .insert(order_returns)
    .values({ order_id: recent.id, comment: "Bracelet rayé à la réception" })
    .returning();
  const [blank] = await db.insert(order_returns).values({ order_id: recent.id, comment: "   " }).returning();
  const [oldNote] = await db
    .insert(order_returns)
    .values({ order_id: recent.id, comment: "Ancien commentaire", created_at: new Date(Date.now() - 60 * 24 * 3600 * 1000) })
    .returning();
  const in30 = new Set((await listReturnCommentsSince(30, { limit: 500 })).items.map((r) => r.id));
  check("30-day window: recent comment listed", in30.has(withNote.id));
  check("blank comment excluded", !in30.has(blank.id));
  check("60-day-old comment outside a 30-day window", !in30.has(oldNote.id));
  const in90 = await listReturnCommentsSince(90, { limit: 500 });
  check(
    "90-day window includes it, and total ≥ listed",
    in90.items.some((r) => r.id === oldNote.id) && in90.total >= in90.items.length,
  );
}

async function main() {
  try {
    await listAndCounts();
    await customer360();
    await phoneLookup();
    await pickScope();
    await warrantyAndReturnsHub();
  } finally {
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
