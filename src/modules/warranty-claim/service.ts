import "server-only";

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { orders } from "@/modules/order/schema";
import { warranty_claims, type WarrantyClaimRow } from "./schema";
import { type WarrantyClaimStatus } from "./claim-taxonomy";

export type WarrantyClaimListRow = {
  id: string;
  orderId: string;
  orderNumber: string;
  orderItemId: string;
  productName: string;
  status: string;
  reasonCode: string | null;
  resolution: string | null;
  wasCovered: boolean;
  externalRef: string | null;
  createdAt: Date;
};

export type WarrantyClaimsDashboardStats = {
  total: number;
  byStatus: Record<string, number>;
  /** Claims opened while still under warranty (was_covered) vs out-of-warranty. */
  coveredCount: number;
  outOfWarrantyCount: number;
  /** Open (non-terminal) claims needing attention right now — counted over ALL
   *  claims regardless of the stats window, so slow-moving SAV cases never age out
   *  of the « En cours » KPI / tab badge. */
  openCount: number;
};

/** Reads for the warranty-claims (SAV / RMA) module — admin console + guards. */
class WarrantyClaimService {
  async findById(id: string, txOrDb: DbOrTx = db): Promise<WarrantyClaimRow | null> {
    const [row] = await txOrDb.select().from(warranty_claims).where(eq(warranty_claims.id, id)).limit(1);
    return row ?? null;
  }

  /** Resolve a claim by its external ERP reference (for the PATCH write-back path). */
  async findByExternalRef(externalRef: string): Promise<WarrantyClaimRow | null> {
    const [row] = await db
      .select()
      .from(warranty_claims)
      .where(eq(warranty_claims.external_ref, externalRef))
      .limit(1);
    return row ?? null;
  }

  async listForOrder(orderId: string): Promise<WarrantyClaimRow[]> {
    return db
      .select()
      .from(warranty_claims)
      .where(eq(warranty_claims.order_id, orderId))
      .orderBy(desc(warranty_claims.created_at));
  }

  /**
   * Batched "which of these orders have at least one warranty claim?" — one
   * indexed query (warranty_claims_order_idx) for the whole list, so the orders
   * list can flag SAV rows without an N+1.
   */
  async orderIdsWithClaims(orderIds: string[]): Promise<Set<string>> {
    if (orderIds.length === 0) return new Set();
    const rows = await db
      .selectDistinct({ orderId: warranty_claims.order_id })
      .from(warranty_claims)
      .where(inArray(warranty_claims.order_id, orderIds));
    return new Set(rows.map((r) => r.orderId));
  }

  /**
   * Is there already a NON-terminal (open / in-progress) claim on this exact sold
   * line? Guards createWarrantyClaim from opening a duplicate active case for the
   * same unit (a resolved/rejected one may be re-claimed — a later fault). Reads
   * on the caller's tx so it can run under the order-row lock.
   */
  async hasOpenClaimForOrderItem(orderItemId: string, txOrDb: DbOrTx = db): Promise<boolean> {
    const [row] = await txOrDb
      .select({ id: warranty_claims.id })
      .from(warranty_claims)
      .where(
        and(
          eq(warranty_claims.order_item_id, orderItemId),
          ne(warranty_claims.status, "resolved"),
          ne(warranty_claims.status, "rejected"),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /**
   * How many ACTIVE (non-resolved, non-rejected) claims exist for a line. A line
   * can hold quantity > 1 physical units, so the create guard allows one open case
   * PER unit (block only at openCount >= quantity) — a customer bringing the 2nd
   * watch of a qty-2 line while the 1st is still in repair must not be refused.
   */
  async countOpenClaimsForOrderItem(orderItemId: string, txOrDb: DbOrTx = db): Promise<number> {
    const [row] = await txOrDb
      .select({ n: sql<number>`count(*)::int` })
      .from(warranty_claims)
      .where(
        and(
          eq(warranty_claims.order_item_id, orderItemId),
          ne(warranty_claims.status, "resolved"),
          ne(warranty_claims.status, "rejected"),
        ),
      );
    return row?.n ?? 0;
  }

  // ─────────────────────────────────────────────── console list + dashboard
  /** Recent claims + their order number for the console list. Optional status filter. */
  async listAllWithOrder(opts: { status?: WarrantyClaimStatus; limit?: number } = {}): Promise<WarrantyClaimListRow[]> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 200);
    const conditions = opts.status ? [eq(warranty_claims.status, opts.status)] : [];
    return db
      .select({
        id: warranty_claims.id,
        orderId: warranty_claims.order_id,
        orderNumber: orders.order_number,
        orderItemId: warranty_claims.order_item_id,
        productName: warranty_claims.product_name,
        status: warranty_claims.status,
        reasonCode: warranty_claims.reason_code,
        resolution: warranty_claims.resolution,
        wasCovered: warranty_claims.was_covered,
        externalRef: warranty_claims.external_ref,
        createdAt: warranty_claims.created_at,
      })
      .from(warranty_claims)
      .innerJoin(orders, eq(orders.id, warranty_claims.order_id))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(warranty_claims.created_at))
      .limit(limit);
  }

  /** Aggregate SAV KPIs over the last `sinceDays` days for the console header. */
  async dashboardStats(sinceDays: number): Promise<WarrantyClaimsDashboardStats> {
    const since = sql`now() - make_interval(days => ${sinceDays})`;
    const inWindow = sql`${warranty_claims.created_at} >= ${since}`;

    const statusRows = await db
      .select({ status: warranty_claims.status, n: sql<number>`count(*)::int` })
      .from(warranty_claims)
      .where(inWindow)
      .groupBy(warranty_claims.status);
    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const r of statusRows) {
      byStatus[r.status] = r.n;
      total += r.n;
    }

    const [{ covered }] = await db
      .select({ covered: sql<number>`count(*) FILTER (WHERE ${warranty_claims.was_covered})::int` })
      .from(warranty_claims)
      .where(inWindow);

    // Open work is counted UNWINDOWED: a claim opened > `sinceDays` ago that is still
    // in repair must stay in the « En cours » KPI + tab badge (the list also surfaces
    // every open claim via listOpenWithOrder), so the count and the visible rows agree.
    const openCount = await this.countOpen();

    return {
      total,
      byStatus,
      coveredCount: Number(covered),
      outOfWarrantyCount: total - Number(covered),
      openCount,
    };
  }

  /** Count of open (non-terminal) claims across ALL time — the authoritative « En
   *  cours » number for the KPI + tab badge (never windowed, never capped). */
  async countOpen(txOrDb: DbOrTx = db): Promise<number> {
    const [row] = await txOrDb
      .select({ n: sql<number>`count(*)::int` })
      .from(warranty_claims)
      .where(
        and(
          ne(warranty_claims.status, "resolved"),
          ne(warranty_claims.status, "rejected"),
        ),
      );
    return row?.n ?? 0;
  }

  /** Every OPEN (non-terminal) claim + its order number, newest first, UNWINDOWED.
   *  The console merges these ahead of the recent-history page so no open case is
   *  ever hidden by the history cap or a stats window. Bounded generously (open work
   *  is small); a store that ever exceeds this has a SAV backlog problem to triage. */
  async listOpenWithOrder(limit = 500): Promise<WarrantyClaimListRow[]> {
    return db
      .select({
        id: warranty_claims.id,
        orderId: warranty_claims.order_id,
        orderNumber: orders.order_number,
        orderItemId: warranty_claims.order_item_id,
        productName: warranty_claims.product_name,
        status: warranty_claims.status,
        reasonCode: warranty_claims.reason_code,
        resolution: warranty_claims.resolution,
        wasCovered: warranty_claims.was_covered,
        externalRef: warranty_claims.external_ref,
        createdAt: warranty_claims.created_at,
      })
      .from(warranty_claims)
      .innerJoin(orders, eq(orders.id, warranty_claims.order_id))
      .where(and(ne(warranty_claims.status, "resolved"), ne(warranty_claims.status, "rejected")))
      .orderBy(desc(warranty_claims.created_at))
      .limit(limit);
  }
}

export const warrantyClaimService = new WarrantyClaimService();
