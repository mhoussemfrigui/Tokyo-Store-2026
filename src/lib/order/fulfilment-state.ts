import "server-only";

import { and, eq, inArray, or } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { order_status_history } from "@/modules/order/schema";
import { orderService } from "@/modules/order/service";
import { stock_movements } from "@/modules/stock-movement";

/**
 * Order fulfilment/refund FACTS shared by the refund, returns, line-edit,
 * shipment and status workflows + the admin order page, so every surface asks
 * the same question the same way (one predicate, not N drifting copies).
 */

/** Cumulative refund-ledger total (millimes) — `SUM(order_refunds.amount_cents)`. */
export function sumRefundCents(refunds: ReadonlyArray<{ amount_cents: number }>): number {
  return refunds.reduce((acc, r) => acc + r.amount_cents, 0);
}

/**
 * The refund LEDGER covers the whole order total. Keyed on the ledger, never on
 * status==='refunded': refundOrderWorkflow does not change the status (a
 * separate manual transition), so a fully refunded order can sit in any status.
 */
export function isFullyRefunded(totalCents: number, refundedCents: number): boolean {
  return refundedCents > 0 && refundedCents >= totalCents;
}

/**
 * Have this order's goods EVER physically left the warehouse? History-based —
 * NOT the current status alone, which lies once an order moved on to the
 * terminal `refunded` (a delivered order marked « Remboursée » still has its
 * goods with the customer). True when ANY of:
 *   - the current status is `shipped` / `delivered`;
 *   - a parcel (bon de livraison) was recorded (`shipments`);
 *   - the status trail ever passed through `shipped` / `delivered` (as a
 *     `to_status` or `from_status` — fulfilment recorded via the status dropdown
 *     writes no shipment rows, but always a history row).
 * Monotonic: once true it stays true. Drives the full-refund restock decision
 * (goods that left are recovered via Returns, never auto-restocked).
 */
export async function goodsLeftWarehouse(
  order: { id: string; status: string },
  t: DbOrTx = db,
): Promise<boolean> {
  if (order.status === "shipped" || order.status === "delivered") return true;
  if ((await orderService.countShipments(order.id, t)) > 0) return true;
  const [row] = await t
    .select({ id: order_status_history.id })
    .from(order_status_history)
    .where(
      and(
        eq(order_status_history.order_id, order.id),
        or(
          inArray(order_status_history.to_status, ["shipped", "delivered"]),
          inArray(order_status_history.from_status, ["shipped", "delivered"]),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Did a refund of this order actually put units back into stock (ledger proof)? */
export async function refundRestockedStock(orderId: string, t: DbOrTx = db): Promise<boolean> {
  const [row] = await t
    .select({ id: stock_movements.id })
    .from(stock_movements)
    .where(and(eq(stock_movements.order_id, orderId), eq(stock_movements.reason, "refund")))
    .limit(1);
  return Boolean(row);
}

/**
 * Must a physical return be REFUSED because a full refund already restored the
 * order's stock? Only for a shipment-less, fully refunded order (with parcels,
 * the refund restocked just the unshipped remainder and the shipped units stay
 * returnable). Blocked when the refund really restocked:
 *   - the goods never left (the full refund restocked the whole quantity), or
 *   - the ledger holds `refund` restock movements (a legacy refund that
 *     restocked goods which had left — re-restocking them would double-count).
 * A full refund of goods that left with no BL restocks NOTHING (refund-order.ts),
 * so the returned units must stay returnable — otherwise they never get back to
 * sellable stock.
 */
export async function returnBlockedByRefundRestock(
  order: { id: string; status: string; total_cents: number },
  facts: { hasShipments: boolean; refundedCents: number },
  t: DbOrTx = db,
): Promise<boolean> {
  if (facts.hasShipments) return false;
  // "Fully refunded" = all the collected cash (total_cents) returned, matching
  // refund-order.ts's full-undo trigger.
  if (!isFullyRefunded(order.total_cents, facts.refundedCents)) return false;
  if (!(await goodsLeftWarehouse(order, t))) return true;
  return refundRestockedStock(order.id, t);
}
