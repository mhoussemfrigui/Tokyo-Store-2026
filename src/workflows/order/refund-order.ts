import "server-only";

import { z } from "zod";

import { orderService } from "@/modules/order/service";
import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { minorToDinars } from "@/lib/price";
import { goodsLeftWarehouse } from "@/lib/order/fulfilment-state";
import { getSharedStockDefault } from "@/lib/inventory/variant-stock";
import { reconcileOrderPromos } from "./reconcile-order-promos";
import { restockOrderLines, emitRestockEvents, type RestockOutcome } from "./restock";
import { stockReservationService } from "@/modules/stock-reservation";
import { fail, ok, workflow } from "../shared";
import type { WorkflowFail } from "../shared";

/**
 * Partial-refund workflow. Records one row in `order_refunds`. Does NOT
 * transition the order's status — that's a separate admin action via the
 * existing transitionStatus path. Refunds are append-only, POSITIVE-only and
 * FINAL: there is no negative/correcting entry (the schema refuses amounts
 * ≤ 0 and no other writer exists), so a mis-typed refund can't be undone here —
 * which is why the admin form asks for an explicit confirmation before a refund
 * that reaches the order total and triggers the side effects below.
 *
 * When the cumulative refund total reaches the order's total_cents the
 * workflow ALSO reverses any promotion redemptions tied to this order:
 *   - inserts a "reversal" redemption row with `discount_cents = -original`
 *     so the audit trail stays balanced (sum across both rows = 0)
 *   - decrements the promotion's `uses_count` so the slot frees up for
 *     another shopper
 * Partial refunds leave the redemption alone — a half-refunded order still
 * counts as one redemption against `max_uses` until it's fully voided.
 *
 * Because the status is left as-is, the downstream workflows key on the refund
 * LEDGER instead: once it covers the total, line edits (edit-items) and new
 * parcels (create-shipment) are refused, and so are forward status moves of an
 * order whose goods never left (transition-status) — the full refund already
 * restocked those units.
 */
const refundSchema = z.object({
  orderId: z.string().uuid(),
  amountCents: z.number().int().positive(),
  reason: z.string().trim().max(2000).optional(),
});

export const refundOrderWorkflow = workflow<
  [z.input<typeof refundSchema>, { actorUserId: string }],
  { refundId: string; totalRefundedCents: number }
>("order.refund", async (input, { actorUserId }) => {
  const parsed = refundSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  // A full refund's restock stock mode (global variant-stock default), resolved
  // BEFORE the tx like place-order / returns / edit-items: read inside it, a
  // cold cache would take a second pool connection while this tx holds one plus
  // the order/stock locks (pool deadlock under concurrent refunds). Cached, so
  // reading it for a partial refund too costs nothing.
  const sharedDefault = await getSharedStockDefault();

  // Everything that mutates state runs in ONE transaction with the order row
  // locked: the refundable-balance read, the refund insert, and (on full
  // refund) the promotion reversal — a crash mid-sequence can never leave a
  // refund row with a half-applied reversal.
  const txResult = await db.transaction<
    | { kind: "fail"; error: WorkflowFail }
    | { kind: "ok"; refundId: string; totalRefundedCents: number; restock: RestockOutcome | null }
  >(async (tx) => {
    // Lock the order row so concurrent refunds serialise — the
    // already-refunded total can't be read stale (double-refund guard).
    const order = await orderService.findById(parsed.data.orderId, tx, {
      forUpdate: true,
    });
    if (!order) {
      return { kind: "fail", error: fail("not_found", "Commande introuvable.") };
    }

    // Only money actually CAPTURED can be refunded. An order with no settled
    // payment (`paid_at` null) — a pending online order, or a COD order before
    // delivery (COD settles `paid_at` at `delivered`) — collected nothing, so a
    // "refund" would record money never taken (corrupting refund/revenue
    // accounting + reversing promotions/coins on a full refund). The correct
    // action for an unpaid order is CANCEL (which restocks). `total_cents` is the
    // captured amount once `paid_at` is set (the app has no partial-capture model).
    if (!order.paid_at) {
      return {
        kind: "fail",
        error: fail(
          "not_paid",
          "Aucun paiement encaissé sur cette commande — annulez-la (cela restocke) plutôt que de la rembourser.",
        ),
      };
    }

    // Cap the new refund to the amount the customer actually paid (total_cents).
    // (Amounts are positive-only — a voided refund can't be logged here.)
    const refundCeilingCents = order.total_cents;
    const existing = await orderService.listRefunds(order.id, tx);
    const alreadyRefunded = existing.reduce((acc, r) => acc + r.amount_cents, 0);
    const remaining = refundCeilingCents - alreadyRefunded;
    if (remaining <= 0) {
      return {
        kind: "fail",
        error: fail(
          "fully_refunded",
          `Commande déjà remboursée intégralement (${minorToDinars(alreadyRefunded)} TND).`,
        ),
      };
    }
    if (parsed.data.amountCents > remaining) {
      return {
        kind: "fail",
        error: fail(
          "exceeds_remaining",
          `Le montant dépasse le solde remboursable (${minorToDinars(remaining)} TND).`,
        ),
      };
    }

    const row = await orderService.insertRefund(
      {
        order_id: order.id,
        amount_cents: parsed.data.amountCents,
        reason: parsed.data.reason ?? null,
        created_by_user_id: actorUserId,
      },
      tx,
    );

    const totalRefundedCents = alreadyRefunded + parsed.data.amountCents;
    let restockOutcome: RestockOutcome | null = null;

    // Promotion reversal — only when the order is now FULLY undone, i.e. all the
    // collected cash (total_cents) has been refunded. Runs on the SAME tx as the
    // refund insert (atomic). Skip rows already flagged as reversals
    // (`discount_cents < 0`) so a double-refund can't double-decrement.
    if (totalRefundedCents >= refundCeilingCents) {
      // Full refund → restock the UNSHIPPED REMAINDER of each line: the units
      // that never left the warehouse (ordered − shipped). A fully-unshipped
      // order restocks in full (mirror of cancellation); a partially-shipped one
      // restocks only what's still on the shelf. The SHIPPED units are with the
      // customer and are recovered via the Returns (SAV) flow (which restocks the
      // physically-received quantity) — so refund(remainder) + return(shipped)
      // together restore exactly the placed quantity, with no double-restock.
      // Guard against double-restock: a `cancelled` order ALREADY had its stock
      // restored by the cancel path (which writes no order_refunds row, so the
      // remaining-balance cap above wouldn't catch a follow-up refund).
      // restockOrderLines is additive, not idempotent.
      if (order.status !== "cancelled") {
        const shippedByItem = await orderService.shippedQtyByItem(order.id, tx);
        // A `shipped`/`delivered` order whose fulfilment was recorded via the
        // status dropdown carries NO shipment_items (a bon de livraison is
        // optional), so `shippedByItem` is empty. Without
        // this guard restockOrderLines would treat the WHOLE quantity as an
        // "unshipped remainder" and add it back to sellable stock — inflating
        // inventory for goods that are already with the customer (oversell). When
        // the goods have physically left and we have no BL to net against, skip
        // the auto-restock: physically-received units are recovered through the
        // Returns (SAV) flow, which restocks exactly what came back.
        // HISTORY-based (goodsLeftWarehouse), not the current status: a partially
        // refunded delivered order already moved to the terminal `refunded`
        // status still has its goods with the customer when the balance is
        // topped up later (e.g. via POST /api/orders/[id]/refunds).
        const goodsLeft = await goodsLeftWarehouse(order, tx);
        if (goodsLeft && shippedByItem.size === 0) {
          restockOutcome = null;
        } else {
          restockOutcome = await restockOrderLines(tx, order.id, "refund", actorUserId, {
            shippedByItem,
            sharedDefault,
          });
        }
      }
      // Release any OPEN précommande reservations on a full refund — the held
      // units were never decremented, so there is nothing to restock; the hold
      // just drops out of `reserved_qty`. No-op if already released (a prior
      // cancel) or converted (those lines restock above). Fold the freed products
      // into the cache-bust set so availability (stock − reserved) refreshes.
      const openHolds = await stockReservationService.listOpenForOrder(tx, order.id);
      if (openHolds.length > 0) {
        await stockReservationService.releaseForOrder(tx, order.id);
        const freedIds = [...new Set(openHolds.map((h) => h.product_id))];
        restockOutcome = {
          touchedProductIds: [...new Set([...(restockOutcome?.touchedProductIds ?? []), ...freedIds])],
          restockedProductIds: restockOutcome?.restockedProductIds ?? [],
        };
      }

      // Full refund → reverse the coupon redemption. Shared with the
      // cancellation path so both undo identically.
      await reconcileOrderPromos(tx, order);
    }

    return { kind: "ok", refundId: row.id, totalRefundedCents, restock: restockOutcome };
  });

  if (txResult.kind === "fail") return txResult.error;

  // Post-commit: a full refund that restocked an unshipped order busts the catalog
  // cache + fires the back-in-stock waitlist (bus side effects run outside the tx).
  if (txResult.restock) await emitRestockEvents(txResult.restock, actorUserId).catch(() => {});

  await bus.emit(
    "order.refunded",
    {
      orderId: parsed.data.orderId,
      refundId: txResult.refundId,
      amountCents: parsed.data.amountCents,
      totalRefundedCents: txResult.totalRefundedCents,
    },
    { actorUserId },
  );

  return ok({
    refundId: txResult.refundId,
    totalRefundedCents: txResult.totalRefundedCents,
  });
});
