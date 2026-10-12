import "server-only";

import { promotionService } from "@/modules/promotion";
import type { DbOrTx } from "@/lib/db/client";
import type { OrderRow } from "@/modules/order/schema";

/**
 * Reverse the promotion effects of an order that is being fully undone — a FULL
 * refund or a cancellation. Shared so both paths reconcile identically;
 * previously only refund did this, so cancellation silently burned coupon slots.
 *
 * Runs on the CALLER's transaction so the reversal commits/rolls back atomically
 * with the refund insert / status transition. Idempotent: promotion reversals
 * skip any redemption already balanced by a negative row (a re-refund can't
 * double-decrement `uses_count`).
 */
export async function reconcileOrderPromos(
  tx: DbOrTx,
  order: Pick<OrderRow, "id">,
): Promise<void> {
  // Promotion reversal: free the coupon slot + log a balancing negative
  // redemption so the audit trail nets to zero. Skip rows already reversed.
  const redemptions = await promotionService.listRedemptionsForOrder(order.id, tx);
  const original = redemptions.filter((r) => r.discount_cents > 0);
  const reversed = new Set(
    redemptions.filter((r) => r.discount_cents < 0).map((r) => r.promotion_id),
  );
  for (const r of original) {
    if (reversed.has(r.promotion_id)) continue; // already reversed
    await promotionService.logRedemption(
      {
        promotion_id: r.promotion_id,
        order_id: order.id,
        user_id: r.user_id,
        code_used: r.code_used,
        discount_cents: -r.discount_cents,
        // Net the waived shipping too, so the Performance stats' cost total
        // returns to what it was before this redemption (a free-ship-ONLY
        // redemption carries discount_cents = 0, so it's not in `original` and
        // stays counted by design — see the schema note).
        shipping_waived_cents: -r.shipping_waived_cents,
      },
      tx,
    );
    await promotionService.decrementUsesCount(r.promotion_id, tx);
  }
}
