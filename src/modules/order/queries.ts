import "server-only";

import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { normalizePhoneDigits } from "@/lib/format/phone";
import { UPFRONT_PAID_METHODS } from "@/lib/order/status";
import {
  order_items,
  order_refunds,
  order_status_history,
  orders,
  type OrderItemRow,
  type OrderRow,
  type OrderStatusHistoryRow,
} from "./schema";
import { order_returns } from "./returns.schema";
import type { ReturnListRow } from "./returns.service";

/**
 * Shared REVENUE base — the ONE definition behind every admin revenue figure:
 * `orderService.stats()` (« Chiffre d'affaires » / « Payées »), the daily series
 * feeding the dashboard + analytics « CA » KPIs, panier moyen and charts, and the
 * « Encaissements » payment-method breakdown. An order counts when it is
 * SETTLED (`paid_at IS NOT NULL` — a COD order counts from its delivery) and NOT
 * cancelled/refunded (`paid_at` survives a cancel/refund, so the status must be
 * checked too). `alias` is how the surrounding query names the orders table
 * (`o` in raw SQL, `orders` under a Drizzle `.from(orders)`); it is always a
 * code constant, never user input.
 */
export function revenueOrderSql(alias: string) {
  const o = sql.raw(alias);
  return sql`(${o}.paid_at IS NOT NULL AND ${o}.status NOT IN ('cancelled', 'refunded'))`;
}

/**
 * An order's NET value (millimes): `total_cents − Σ order_refunds.amount_cents`
 * — nets partial refunds, and full refunds whose status was never flipped to
 * `refunded` (refundOrderWorkflow doesn't transition the status). Correlated
 * subquery backed by `order_refunds_order_idx`. Pair with `revenueOrderSql`.
 */
export function netOrderCentsSql(alias: string) {
  const o = sql.raw(alias);
  return sql`(${o}.total_cents - COALESCE((SELECT SUM(r.amount_cents) FROM ${order_refunds} r WHERE r.order_id = ${o}.id), 0))`;
}

/**
 * An order's NET REVENUE (millimes): net-of-refunds value, clamped ≥ 0 so an
 * over-refunded order can't drive revenue negative. The base for the « CA » KPIs
 * and the daily revenue series. « Encaissements » (cash-drawer) uses the raw
 * {@link netOrderCentsSql} instead — the clamp is the only difference.
 */
export function netRevenueCentsSql(alias: string) {
  return sql`GREATEST(0, ${netOrderCentsSql(alias)})`;
}

/**
 * SQL twin of `isActionableOrder` (lib/order/status.ts) — the « À traiter »
 * queue: paid / preparing, plus a pending order that is NOT an unpaid online
 * checkout (COD / unset method, or already carrying `paid_at`). The upfront
 * IN-list is built from the same exported `UPFRONT_PAID_METHODS`.
 *
 * A SPAM-flagged order is never a fulfilment task, so it is excluded here — this
 * keeps the « À traiter » KPI, queue filter and `stats().actionable` all off the
 * spam set in one place (the list's default view hides spam separately).
 */
export function actionableOrderSql(alias: string) {
  const o = sql.raw(alias);
  const upfront = sql.join(
    UPFRONT_PAID_METHODS.map((m) => sql`${m}`),
    sql`, `,
  );
  return sql`(${o}.flagged_spam_at IS NULL AND (${o}.status IN ('paid', 'preparing') OR (${o}.status = 'pending' AND (${o}.payment_method IS NULL OR ${o}.payment_method NOT IN (${upfront}) OR ${o}.paid_at IS NOT NULL))))`;
}

export async function listOrdersForUser(
  userId: string,
  opts: { limit?: number } = {},
): Promise<OrderRow[]> {
  // Cap the rows we return. A long-time customer can rack up hundreds of
  // orders; the storefront /account view paginates client-side from
  // whatever it gets here, so an unbounded scan is wasted work.
  return db
    .select()
    .from(orders)
    .where(and(eq(orders.user_id, userId)))
    .orderBy(desc(orders.created_at))
    .limit(Math.min(opts.limit ?? 100, 500));
}

export type UserOrderSummary = {
  orderCount: number;
  /** Sum of total_cents across ALL of the person's orders. */
  lifetimeSpendCents: number;
  /** Sum of total_cents across PAID orders only (money actually received). */
  paidSpendCents: number;
  lastOrderAt: Date | null;
  firstOrderAt: Date | null;
};

/**
 * A person's orders matched by their auth user_id, plus the GUEST checkouts
 * (`user_id IS NULL`) placed under their email (case-insensitive) before
 * sign-up / linking. The email arm is restricted to guest orders: another
 * account's order merely TYPED with this address belongs to that account (the
 * customer's own /account view never shows it), so it must not land in this
 * person's 360 list or lifetime spend. With no account (`userId` null) the plain
 * email match stays. Returns an empty match when neither identifier is provided.
 */
function userOrEmailCond(userId: string | null, email: string | null) {
  const mail = (email ?? "").trim().toLowerCase();
  const emailMatch = mail ? sql`lower(${orders.contact_email}) = ${mail}` : undefined;
  return or(
    userId ? eq(orders.user_id, userId) : undefined,
    emailMatch && userId ? and(isNull(orders.user_id), emailMatch) : emailMatch,
  );
}

export async function getUserOrderSummary(
  userId: string | null,
  email: string | null,
): Promise<UserOrderSummary> {
  const empty: UserOrderSummary = {
    orderCount: 0,
    lifetimeSpendCents: 0,
    paidSpendCents: 0,
    lastOrderAt: null,
    firstOrderAt: null,
  };
  if (!userId && !(email ?? "").trim()) return empty;
  const [row] = await db
    .select({
      orderCount: sql<number>`count(*)::int`,
      lifetimeSpendCents: sql<string>`coalesce(sum(${orders.total_cents}), 0)`,
      paidSpendCents: sql<string>`coalesce(sum(${orders.total_cents}) filter (where ${orders.paid_at} is not null), 0)`,
      lastOrderAt: sql<string | null>`max(${orders.created_at})`,
      firstOrderAt: sql<string | null>`min(${orders.created_at})`,
    })
    .from(orders)
    .where(userOrEmailCond(userId, email));
  return {
    orderCount: Number(row?.orderCount ?? 0),
    lifetimeSpendCents: Number(row?.lifetimeSpendCents ?? 0),
    paidSpendCents: Number(row?.paidSpendCents ?? 0),
    lastOrderAt: row?.lastOrderAt ? new Date(row.lastOrderAt) : null,
    firstOrderAt: row?.firstOrderAt ? new Date(row.firstOrderAt) : null,
  };
}

/**
 * How many orders this ACCOUNT has already placed (any non-cancelled status) —
 * the « first order » gate for a new-customer welcome coupon. Counts by `user_id`
 * only (a guest has no stable identity, so a first-order coupon requires an
 * account — see `evaluateCouponEligibility`). Cancelled orders don't count (they
 * were never a real purchase); the order CURRENTLY being placed isn't inserted yet
 * when eligibility runs, so 0 here = this is genuinely their first order.
 */
export async function countPriorPlacedOrders(userId: string, txOrDb: DbOrTx = db): Promise<number> {
  const [row] = await txOrDb
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(and(eq(orders.user_id, userId), ne(orders.status, "cancelled")));
  return Number(row?.n ?? 0);
}

/**
 * SET-WISE « has this account already placed an order? » — the ids among `userIds`
 * that have ≥1 non-cancelled order (same predicate as {@link countPriorPlacedOrders}).
 * Used by the announcement audience so a `first_order_only` welcome coupon is mailed
 * ONLY to first-time buyers (returning customers would be refused the code) — the
 * mailing counterpart of the checkout `not_first_order` gate. Empty input → empty set.
 */
export async function userIdsWithPlacedOrders(userIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (userIds.length === 0) return out;
  const rows = await db
    .selectDistinct({ userId: orders.user_id })
    .from(orders)
    .where(and(inArray(orders.user_id, userIds), ne(orders.status, "cancelled")));
  for (const r of rows) if (r.userId) out.add(r.userId);
  return out;
}

export async function listOrdersForUserOrEmail(
  userId: string | null,
  email: string | null,
  opts: { limit?: number } = {},
): Promise<OrderRow[]> {
  if (!userId && !(email ?? "").trim()) return [];
  return db
    .select()
    .from(orders)
    .where(userOrEmailCond(userId, email))
    .orderBy(desc(orders.created_at))
    .limit(Math.min(opts.limit ?? 100, 500));
}

export async function findOrderById(id: string): Promise<OrderRow | null> {
  const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  return row ?? null;
}

/**
 * Exact order-number lookup (case-insensitive) — admin warranty / SAV search.
 * The `upper()` wrapper is index-backed by the functional index
 * `orders_order_number_upper_idx` (migration 0098), so this is an index scan,
 * not a seq scan, on a large orders table.
 */
export async function findOrderByNumber(orderNumber: string): Promise<OrderRow | null> {
  const n = orderNumber.trim();
  if (!n) return null;
  const [row] = await db
    .select()
    .from(orders)
    .where(sql`upper(${orders.order_number}) = ${n.toUpperCase()}`)
    .limit(1);
  return row ?? null;
}

/** Significant trailing digits of a phone number — a Tunisian national number is
 *  8 digits, so « +216 12 345 678 », « 0021612345678 » and « 12 345 678 » share
 *  them whatever prefix the customer typed at checkout. */
const PHONE_MATCH_DIGITS = 8;

/**
 * Orders matched by customer phone — admin warranty / SAV search. Matches the
 * raw stored phone (index-backed) OR, once the typed number has at least
 * {@link PHONE_MATCH_DIGITS} digits, the LAST 8 digits of both sides — so
 * "+216 12 345 678", "21612345678", "0021612345678" and "12 345 678" all find
 * each other (contact phones are stored exactly as typed). A shorter entry keeps
 * the exact digits-only match. Scoped to this SAV lookup on purpose: the shared
 * `normalizePhoneDigits` (guest grouping, settings validation) is unchanged. The
 * `right(…)` arm is not index-backed — an admin-only, LIMIT-bounded scan. Two
 * different countries' numbers sharing their last 8 digits would both match;
 * the operator sees each order's full number before acting.
 */
export async function listOrdersByPhone(
  phone: string,
  opts: { limit?: number } = {},
): Promise<OrderRow[]> {
  const p = phone.trim();
  const digits = normalizePhoneDigits(p);
  if (!p || !digits) return [];
  const storedDigits = sql`regexp_replace(${orders.contact_phone}, '\\D', '', 'g')`;
  return db
    .select()
    .from(orders)
    .where(
      or(
        eq(orders.contact_phone, p),
        digits.length >= PHONE_MATCH_DIGITS
          ? sql`right(${storedDigits}, ${PHONE_MATCH_DIGITS}) = ${digits.slice(-PHONE_MATCH_DIGITS)}`
          : sql`${storedDigits} = ${digits}`,
      ),
    )
    .orderBy(desc(orders.created_at))
    .limit(Math.min(opts.limit ?? 50, 200));
}

/**
 * When each order was DELIVERED — the earliest `→ delivered` status-history row
 * per order (warranty start, see `warrantyStartDate`). Orders never delivered
 * are absent from the map. One grouped query for the whole lookup.
 */
export async function deliveredAtByOrder(orderIds: string[]): Promise<Map<string, Date>> {
  if (orderIds.length === 0) return new Map();
  const rows = await db
    .select({
      orderId: order_status_history.order_id,
      at: sql<Date>`min(${order_status_history.created_at})`.mapWith(order_status_history.created_at),
    })
    .from(order_status_history)
    .where(
      and(
        inArray(order_status_history.order_id, orderIds),
        eq(order_status_history.to_status, "delivered"),
      ),
    )
    .groupBy(order_status_history.order_id);
  return new Map(rows.map((r) => [r.orderId, r.at]));
}

/**
 * Pending returns still to process — ALL of them, whatever their age: the
 * Retours hub's « En attente » to-do KPI must not lose a return raised before the
 * analysis window (`dashboardStats` is window-scoped).
 */
export async function countPendingReturns(kind?: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
    .from(order_returns)
    .where(
      kind
        ? and(eq(order_returns.status, "pending"), eq(order_returns.kind, kind))
        : eq(order_returns.status, "pending"),
    );
  return row?.n ?? 0;
}

/**
 * Operator comments on returns raised within the last `sinceDays` days (the
 * Retours hub's selected window), newest first — queried server-side instead of
 * filtering the 100 most recent returns, so older comments in the window aren't
 * silently dropped. Returns the window's TOTAL alongside the capped page.
 */
export async function listReturnCommentsSince(
  sinceDays: number,
  opts: { limit?: number; kind?: string } = {},
): Promise<{ total: number; items: ReturnListRow[] }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 500);
  const where = and(
    sql`${order_returns.created_at} >= now() - make_interval(days => ${sinceDays})`,
    isNotNull(order_returns.comment),
    sql`btrim(${order_returns.comment}) <> ''`,
    opts.kind ? eq(order_returns.kind, opts.kind) : undefined,
  );
  const [[countRow], items] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int`.mapWith(Number) })
      .from(order_returns)
      .where(where),
    db
      .select({
        id: order_returns.id,
        orderId: order_returns.order_id,
        orderNumber: orders.order_number,
        status: order_returns.status,
        reasonCode: order_returns.reason_code,
        comment: order_returns.comment,
        createdAt: order_returns.created_at,
      })
      .from(order_returns)
      .innerJoin(orders, eq(orders.id, order_returns.order_id))
      .where(where)
      .orderBy(desc(order_returns.created_at), desc(order_returns.id))
      .limit(limit),
  ]);
  return { total: countRow?.n ?? 0, items };
}

export async function listItemsForOrder(orderId: string): Promise<OrderItemRow[]> {
  return db
    .select()
    .from(order_items)
    .where(eq(order_items.order_id, orderId));
}

/** Items for several orders in one query (e.g. the warranty overview). */
export async function listItemsForOrders(orderIds: string[]): Promise<OrderItemRow[]> {
  if (orderIds.length === 0) return [];
  return db.select().from(order_items).where(inArray(order_items.order_id, orderIds));
}

/** Several orders by id in ONE query — avoids the per-id findOrderById N+1
 *  (e.g. the warranty lookup, which resolves many orders from an order-number /
 *  phone match). */
export async function findOrdersByIds(orderIds: string[]): Promise<OrderRow[]> {
  if (orderIds.length === 0) return [];
  return db.select().from(orders).where(inArray(orders.id, orderIds));
}

export async function listStatusHistory(
  orderId: string,
): Promise<OrderStatusHistoryRow[]> {
  return db
    .select()
    .from(order_status_history)
    .where(eq(order_status_history.order_id, orderId))
    .orderBy(desc(order_status_history.created_at));
}

/**
 * Per-day order count + revenue for the last N days.
 * Includes a 0-filled row for empty days so the chart axis doesn't gap.
 * Counts only the shared REVENUE base (`revenueOrderSql`: settled, not
 * cancelled/refunded) valued NET of refunds (`netRevenueCentsSql`), bucketed by
 * the order's `created_at` day — so `count` is « commandes payées » and
 * revenue/count is a true panier moyen. (An unpaid COD order joins its day once
 * delivered; a refund lowers its day retroactively.)
 */
export async function getDailyOrdersSeries(
  days = 30,
): Promise<Array<{ day: string; count: number; revenueCents: number }>> {
  // `days - 1`: generate_series is inclusive of BOTH endpoints, so spanning
  // N-1 days ago → today yields exactly N daily rows (not N+1), matching the
  // "N j" / "N derniers jours" labels the dashboard + analytics render.
  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  const rows = await db.execute<{
    day: string;
    count: string;
    revenue_cents: string;
  }>(sql`
    WITH day_series AS (
      SELECT generate_series(
        (${since.toISOString()}::timestamptz AT TIME ZONE 'Africa/Tunis')::date,
        (now() AT TIME ZONE 'Africa/Tunis')::date,
        '1 day'::interval
      )::date AS day
    )
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS day,
      COALESCE(COUNT(o.id)::int, 0)::text AS count,
      COALESCE(SUM(${netRevenueCentsSql("o")})::bigint, 0)::text AS revenue_cents
    FROM day_series d
    LEFT JOIN ${orders} o
      ON o.created_at >= (d.day::timestamp AT TIME ZONE 'Africa/Tunis')
      AND o.created_at < ((d.day + INTERVAL '1 day')::timestamp AT TIME ZONE 'Africa/Tunis')
      AND ${revenueOrderSql("o")}
    GROUP BY d.day
    ORDER BY d.day ASC
  `);
  return rows.rows.map((r) => ({
    day: r.day,
    count: Number(r.count),
    revenueCents: Number(r.revenue_cents),
  }));
}

/** Order count by status — for the donut/badge cluster on the dashboard. */
export async function getStatusDistribution(): Promise<
  Array<{ status: string; count: number }>
> {
  const rows = await db
    .select({
      status: orders.status,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(orders)
    .groupBy(orders.status);
  return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
}

/**
 * Top N products by total quantity sold (paid+ orders only, last `daysWindow`
 * days). The name comes from the order-line snapshot (`product_name`), so no
 * catalog join is needed and since-deleted products still report correctly.
 * Grouped by product id ONLY (a product renamed mid-window stays one row,
 * labelled with its most recent snapshot name) and ranked on the NUMERIC
 * aggregates — `qty` is emitted as text for the driver, and a bare
 * `ORDER BY qty` would sort that text column ("9" > "45" > "100"). Revenue then
 * product id break ties deterministically.
 */
export async function getTopSellingProducts(
  limit = 5,
  daysWindow = 90,
): Promise<Array<{ productId: string; productName: string; quantity: number; revenueCents: number }>> {
  const since = new Date(Date.now() - daysWindow * 24 * 60 * 60 * 1000);
  const rows = await db.execute<{
    product_id: string;
    product_name: string;
    qty: string;
    revenue_cents: string;
  }>(sql`
    SELECT
      oi.product_id,
      (array_agg(oi.product_name ORDER BY o.created_at DESC, oi.id DESC))[1] AS product_name,
      SUM(oi.quantity)::int::text AS qty,
      SUM(oi.subtotal_cents)::bigint::text AS revenue_cents
    FROM ${order_items} oi
    JOIN ${orders} o ON o.id = oi.order_id
    WHERE o.status IN ('paid','preparing','shipped','delivered')
      AND o.created_at >= ${since.toISOString()}::timestamptz
    GROUP BY oi.product_id
    ORDER BY SUM(oi.quantity) DESC, SUM(oi.subtotal_cents) DESC, oi.product_id
    LIMIT ${limit}
  `);
  return rows.rows.map((r) => ({
    productId: r.product_id,
    productName: r.product_name,
    quantity: Number(r.qty),
    revenueCents: Number(r.revenue_cents),
  }));
}

/**
 * Settled-revenue + order count grouped by payment method over the last N days.
 * Same shared REVENUE base as `stats()` and `getDailyOrdersSeries`
 * (`revenueOrderSql`: `paid_at IS NOT NULL` — money actually received, so a COD
 * order only counts once cash is collected at delivery — and not
 * cancelled/refunded), valued NET of refunds (`netOrderCentsSql`). The ONE
 * intentional difference: this is bucketed by `paid_at` (when the cash came in)
 * while the daily « CA » series is bucketed by `created_at` (order date) — so
 * the two window totals won't reconcile row-for-row (e.g. an order created last
 * window but paid this one). Ordered by revenue desc. Admin-analytics-only
 * (infrequent), so the `paid_at` range scan is acceptable — there is no dedicated
 * paid_at index by design (the schema is intentionally not over-indexed; the same
 * holds for the sibling daily revenue series); the GROUP BY is over the small
 * payment_method enum.
 */
export async function getPaymentMethodBreakdown(
  days = 30,
): Promise<Array<{ method: string; orders: number; revenueCents: number }>> {
  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      method: orders.payment_method,
      orders: sql<number>`count(*)::int`,
      revenueCents: sql<string>`coalesce(sum(${netOrderCentsSql("orders")}), 0)::bigint::text`,
    })
    .from(orders)
    .where(and(isNotNull(orders.paid_at), gte(orders.paid_at, since), revenueOrderSql("orders")))
    .groupBy(orders.payment_method);
  return rows
    .map((r) => ({
      method: String(r.method),
      orders: Number(r.orders),
      revenueCents: Number(r.revenueCents),
    }))
    .sort((a, b) => b.revenueCents - a.revenueCents);
}

/** Newsletter subscriptions per day for the last N days. */
export async function getNewsletterSignupsSeries(
  days = 30,
): Promise<Array<{ day: string; count: number }>> {
  // `days - 1`: generate_series is inclusive of BOTH endpoints, so spanning
  // N-1 days ago → today yields exactly N daily rows (not N+1), matching the
  // "N j" / "N derniers jours" labels the dashboard + analytics render.
  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  const rows = await db.execute<{ day: string; count: string }>(sql`
    WITH day_series AS (
      SELECT generate_series(
        (${since.toISOString()}::timestamptz AT TIME ZONE 'Africa/Tunis')::date,
        (now() AT TIME ZONE 'Africa/Tunis')::date,
        '1 day'::interval
      )::date AS day
    )
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS day,
      COALESCE(COUNT(n.id)::int, 0)::text AS count
    FROM day_series d
    LEFT JOIN newsletter_subscriptions n
      ON n.created_at >= (d.day::timestamp AT TIME ZONE 'Africa/Tunis')
      AND n.created_at < ((d.day + INTERVAL '1 day')::timestamp AT TIME ZONE 'Africa/Tunis')
    GROUP BY d.day
    ORDER BY d.day ASC
  `);
  return rows.rows.map((r) => ({ day: r.day, count: Number(r.count) }));
}

export async function getNewUsersSeries(
  days = 30,
): Promise<Array<{ day: string; count: number }>> {
  // `days - 1`: generate_series is inclusive of BOTH endpoints, so spanning
  // N-1 days ago → today yields exactly N daily rows (not N+1), matching the
  // "N j" / "N derniers jours" labels the dashboard + analytics render.
  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  const rows = await db.execute<{ day: string; count: string }>(sql`
    WITH day_series AS (
      SELECT generate_series(
        (${since.toISOString()}::timestamptz AT TIME ZONE 'Africa/Tunis')::date,
        (now() AT TIME ZONE 'Africa/Tunis')::date,
        '1 day'::interval
      )::date AS day
    )
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS day,
      COALESCE(COUNT(u.id)::int, 0)::text AS count
    FROM day_series d
    LEFT JOIN users u
      ON u.created_at >= (d.day::timestamp AT TIME ZONE 'Africa/Tunis')
      AND u.created_at < ((d.day + INTERVAL '1 day')::timestamp AT TIME ZONE 'Africa/Tunis')
    GROUP BY d.day
    ORDER BY d.day ASC
  `);
  return rows.rows.map((r) => ({ day: r.day, count: Number(r.count) }));
}

// Guest-clients listing moved to src/lib/customers/guest-filter.ts (the filterable
// « Invités » tab: search + stats + keyset pagination + account enrichment + export).

/** Open (unconverted) preorder reservation counts per product — total UNITS +
 *  distinct ORDERS — from the order lines flagged is_preorder. Drives the
 *  Précommandes queue's per-product cue.
 *
 *  Cancel / full-refund RELEASE the reservation (reserved_qty drops) but do NOT
 *  flip `order_items.is_preorder` back (only conversion does), so a cancelled /
 *  refunded order's lines would otherwise keep inflating this count past the real
 *  reserved units. Exclude those terminal statuses so the KPI tracks the open
 *  holds. (Partial refunds don't release holds and keep a live status → counted.) */
export async function openPreorderCountsByProduct(
  productIds: string[],
): Promise<Map<string, { units: number; orders: number }>> {
  const out = new Map<string, { units: number; orders: number }>();
  if (productIds.length === 0) return out;
  const rows = await db
    .select({
      productId: order_items.product_id,
      units: sql<number>`coalesce(sum(${order_items.quantity}), 0)::int`,
      orders: sql<number>`count(distinct ${order_items.order_id})::int`,
    })
    .from(order_items)
    .innerJoin(orders, eq(orders.id, order_items.order_id))
    .where(
      and(
        inArray(order_items.product_id, productIds),
        eq(order_items.is_preorder, true),
        notInArray(orders.status, ["cancelled", "refunded"]),
      ),
    )
    .groupBy(order_items.product_id);
  for (const r of rows) out.set(r.productId, { units: r.units, orders: r.orders });
  return out;
}
