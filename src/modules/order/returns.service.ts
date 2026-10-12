import "server-only";

import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { orders, order_items } from "./schema";
import {
  order_returns,
  order_return_items,
  type OrderReturnRow,
  type OrderReturnItemRow,
} from "./returns.schema";

export type ReturnsDashboardStats = {
  total: number;
  byStatus: Record<string, number>;
  byReason: Array<{ code: string | null; count: number }>;
  topProducts: Array<{ name: string; units: number }>;
  /** Orders CREATED in the window (the return-rate denominator). */
  ordersInWindow: number;
  /** Of those, how many have ≥1 return (the return-rate numerator). A subset of
   *  `ordersInWindow`, so the rate below is always in [0,100]. */
  returnedOrdersInWindow: number;
  /** `returnedOrdersInWindow / ordersInWindow` — the fraction of orders that got a
   *  return (standard cohort return rate), NOT returns-per-order (which a
   *  multi-return order could push past 100%). */
  returnRatePct: number;
  /** received / (received + rejected) — how often a raised return is accepted. */
  restockRatePct: number;
};

export type ReturnListRow = {
  id: string;
  orderId: string;
  orderNumber: string;
  status: string;
  reasonCode: string | null;
  comment: string | null;
  createdAt: Date;
};

/** A « Retour d'expédition » row for the dedicated sub-tab (carrier metadata). */
export type ShipmentReturnListRow = {
  id: string;
  orderId: string;
  orderNumber: string;
  status: string;
  reasonCode: string | null;
  carrierName: string | null;
  trackingRef: string | null;
  deliveryAttempts: number | null;
  createdAt: Date;
};

/** Compact KPIs for the « Retour d'expédition » sub-tab over a window. */
export type ShipmentReturnStats = {
  total: number;
  byStatus: Record<string, number>;
  byReason: Array<{ code: string | null; count: number }>;
  byCarrier: Array<{ carrier: string; count: number }>;
};

/** Reads for the returns (retours) module — admin views + over-return guard. */
class ReturnService {
  async findById(id: string): Promise<OrderReturnRow | null> {
    const [row] = await db.select().from(order_returns).where(eq(order_returns.id, id)).limit(1);
    return row ?? null;
  }

  async listForOrder(orderId: string): Promise<OrderReturnRow[]> {
    return db
      .select()
      .from(order_returns)
      .where(eq(order_returns.order_id, orderId))
      .orderBy(desc(order_returns.created_at));
  }

  /**
   * Batched "which of these orders have at least one AFTER-SALE return?" — one
   * indexed query for the whole list, so the orders list can flag rows with a
   * SAV/retour without an N+1. Scoped to `kind='after_sale'` so an RTO (« Retour
   * d'expédition ») bounce never lights the orders-list « Retour (SAV) » badge
   * (it surfaces on the Retour d'expédition tab instead). Returns the id set.
   */
  async orderIdsWithReturns(orderIds: string[]): Promise<Set<string>> {
    if (orderIds.length === 0) return new Set();
    const rows = await db
      .selectDistinct({ orderId: order_returns.order_id })
      .from(order_returns)
      .where(and(inArray(order_returns.order_id, orderIds), eq(order_returns.kind, "after_sale")));
    return new Set(rows.map((r) => r.orderId));
  }

  async listItems(returnId: string): Promise<OrderReturnItemRow[]> {
    return db.select().from(order_return_items).where(eq(order_return_items.return_id, returnId));
  }

  async listItemsForReturns(returnIds: string[]): Promise<Map<string, OrderReturnItemRow[]>> {
    const map = new Map<string, OrderReturnItemRow[]>();
    if (returnIds.length === 0) return map;
    const rows = await db
      .select()
      .from(order_return_items)
      .where(inArray(order_return_items.return_id, returnIds));
    for (const r of rows) {
      const list = map.get(r.return_id);
      if (list) list.push(r);
      else map.set(r.return_id, [r]);
    }
    return map;
  }

  /**
   * Units already returned per order_item across this order's NON-rejected
   * returns — so a new return can't exceed what was sold (minus prior returns).
   */
  async returnedQtyByOrderItem(
    orderId: string,
    txOrDb: DbOrTx = db,
  ): Promise<Map<string, number>> {
    const rows = await txOrDb
      .select({
        orderItemId: order_return_items.order_item_id,
        qty: sql<number>`coalesce(sum(${order_return_items.quantity}), 0)::int`.mapWith(Number),
      })
      .from(order_return_items)
      .innerJoin(order_returns, eq(order_returns.id, order_return_items.return_id))
      .where(and(eq(order_returns.order_id, orderId), ne(order_returns.status, "rejected")))
      .groupBy(order_return_items.order_item_id);
    return new Map(rows.map((r) => [r.orderItemId, r.qty]));
  }

  // ──────────────────────────────────────────────────── dashboard (Retours hub)
  /**
   * Aggregate return KPIs over the last `sinceDays` days for the Retours
   * dashboard. `kind` scopes the aggregation to one flow — the « Retour après
   * vente » tab passes `'after_sale'` so RTO bounces never inflate the SAV
   * return rate / top-returned products. Omitted = every kind.
   */
  async dashboardStats(sinceDays: number, kind?: string): Promise<ReturnsDashboardStats> {
    const since = sql`now() - make_interval(days => ${sinceDays})`;
    // AND-ed into every return-scoped query (the orders-scoped denominator stays
    // whole-store). `sql.empty()` keeps the fragment inert when no kind is given.
    const kindFilter = kind ? sql` and ${order_returns.kind} = ${kind}` : sql.empty();

    const statusRows = await db
      .select({ status: order_returns.status, n: sql<number>`count(*)::int` })
      .from(order_returns)
      .where(sql`${order_returns.created_at} >= ${since}${kindFilter}`)
      .groupBy(order_returns.status);
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of statusRows) {
      byStatus[r.status] = r.n;
      total += r.n;
    }

    const reasonRows = await db
      .select({ code: order_returns.reason_code, n: sql<number>`count(*)::int` })
      .from(order_returns)
      .where(sql`${order_returns.created_at} >= ${since}${kindFilter}`)
      .groupBy(order_returns.reason_code)
      .orderBy(sql`count(*) desc`);

    // Group by product_id (stable identity), NOT the free-text per-line snapshot name:
    // two distinct products sharing a snapshot name would otherwise collapse into one row
    // (and a renamed product split into two). Pick the most-recent snapshot name as the
    // label — mirrors getTopSellingProducts (order/queries.ts).
    const topRows = await db
      .select({
        name: sql<string>`(array_agg(${order_items.product_name} ORDER BY ${order_returns.created_at} DESC))[1]`,
        units: sql<number>`sum(${order_return_items.quantity})::int`,
      })
      .from(order_return_items)
      .innerJoin(order_returns, eq(order_returns.id, order_return_items.return_id))
      .innerJoin(order_items, eq(order_items.id, order_return_items.order_item_id))
      .where(sql`${order_returns.created_at} >= ${since}${kindFilter}`)
      .groupBy(order_return_items.product_id)
      .orderBy(sql`sum(${order_return_items.quantity}) desc`, order_return_items.product_id)
      .limit(10);

    const [{ n: ordersInWindow }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(orders)
      .where(sql`${orders.created_at} >= ${since}`);

    // Return-rate numerator: DISTINCT orders created in the window that have at least
    // one return (any status, any time) OF THIS KIND. Counting orders — not return
    // records — keeps the ratio a true fraction: it's a strict subset of
    // ordersInWindow, so the rate can never exceed 100% even when an order has several
    // returns.
    const [{ n: returnedOrdersInWindow }] = await db
      .select({ n: sql<number>`count(distinct ${orders.id})::int` })
      .from(orders)
      .innerJoin(order_returns, eq(order_returns.order_id, orders.id))
      .where(sql`${orders.created_at} >= ${since}${kindFilter}`);

    const received = byStatus.received ?? 0;
    const rejected = byStatus.rejected ?? 0;
    const processed = received + rejected;
    return {
      total,
      byStatus,
      byReason: reasonRows.map((r) => ({ code: r.code, count: r.n })),
      topProducts: topRows.map((r) => ({ name: r.name, units: Number(r.units) })),
      ordersInWindow,
      returnedOrdersInWindow,
      returnRatePct:
        ordersInWindow > 0 ? Math.round((returnedOrdersInWindow / ordersInWindow) * 1000) / 10 : 0,
      restockRatePct: processed > 0 ? Math.round((received / processed) * 1000) / 10 : 0,
    };
  }

  /** Recent returns + their order number for the Retours dashboard list.
   *  `kind` scopes to one flow (the SAV tab passes 'after_sale'). */
  async listAllWithOrder(limit = 100, kind?: string): Promise<ReturnListRow[]> {
    const rows = await db
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
      .where(kind ? eq(order_returns.kind, kind) : undefined)
      .orderBy(desc(order_returns.created_at))
      .limit(limit);
    return rows;
  }

  // ───────────────────────────────────────────── « Retour d'expédition » (RTO)
  /** Recent shipment-return rows (+ carrier metadata) for the dedicated sub-tab. */
  async listShipmentReturnsWithOrder(limit = 100): Promise<ShipmentReturnListRow[]> {
    return db
      .select({
        id: order_returns.id,
        orderId: order_returns.order_id,
        orderNumber: orders.order_number,
        status: order_returns.status,
        reasonCode: order_returns.reason_code,
        carrierName: order_returns.carrier_name,
        trackingRef: order_returns.tracking_ref,
        deliveryAttempts: order_returns.delivery_attempts,
        createdAt: order_returns.created_at,
      })
      .from(order_returns)
      .innerJoin(orders, eq(orders.id, order_returns.order_id))
      .where(eq(order_returns.kind, "shipment"))
      .orderBy(desc(order_returns.created_at))
      .limit(limit);
  }

  /** Compact KPIs for the « Retour d'expédition » sub-tab over a window. */
  async shipmentReturnStats(sinceDays: number): Promise<ShipmentReturnStats> {
    const since = sql`now() - make_interval(days => ${sinceDays})`;
    const where = and(
      sql`${order_returns.created_at} >= ${since}`,
      eq(order_returns.kind, "shipment"),
    );

    const statusRows = await db
      .select({ status: order_returns.status, n: sql<number>`count(*)::int` })
      .from(order_returns)
      .where(where)
      .groupBy(order_returns.status);
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of statusRows) {
      byStatus[r.status] = r.n;
      total += r.n;
    }

    const reasonRows = await db
      .select({ code: order_returns.reason_code, n: sql<number>`count(*)::int` })
      .from(order_returns)
      .where(where)
      .groupBy(order_returns.reason_code)
      .orderBy(sql`count(*) desc`);

    const carrierRows = await db
      .select({ carrier: order_returns.carrier_name, n: sql<number>`count(*)::int` })
      .from(order_returns)
      .where(and(where, isNotNull(order_returns.carrier_name)))
      .groupBy(order_returns.carrier_name)
      .orderBy(sql`count(*) desc`)
      .limit(10);

    return {
      total,
      byStatus,
      byReason: reasonRows.map((r) => ({ code: r.code, count: r.n })),
      byCarrier: carrierRows
        .filter((r) => r.carrier)
        .map((r) => ({ carrier: r.carrier as string, count: r.n })),
    };
  }
}

export const returnService = new ReturnService();
