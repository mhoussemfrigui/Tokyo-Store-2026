import "server-only";

import { z } from "zod";

import { orderService } from "@/modules/order/service";
import { orderTransitionsFor, type OrderStatus } from "@/lib/order/status";
import { isOnlineMethod } from "@/lib/payments/shared";
import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { goodsLeftWarehouse, isFullyRefunded, sumRefundCents } from "@/lib/order/fulfilment-state";
import { getSharedStockDefault } from "@/lib/inventory/variant-stock";
import { reconcileOrderPromos } from "./reconcile-order-promos";
import { restockOrderLines, emitRestockEvents, type RestockOutcome } from "./restock";
// Circular with gateway-payment (confirmPaymentWorkflow → this workflow, to
// `paid` only) — safe: both bindings are only dereferenced at call time.
import { assertPendingOnlineOrderNotCaptured } from "./gateway-payment";
import { fail, ok, workflow } from "../shared";
import type { WorkflowFail } from "../shared";

const ALL_STATUSES = [
  "pending",
  "paid",
  "preparing",
  "shipped",
  "delivered",
  "cancelled",
  "refunded",
] as const;

/** Statuses that move an order FORWARD through payment/fulfilment. */
const FORWARD_STATUSES = new Set<string>(["paid", "preparing", "shipped", "delivered"]);

export const transitionStatusSchema = z.object({
  orderId: z.string().uuid(),
  toStatus: z.enum(ALL_STATUSES),
  notes: z.string().optional(),
  paymentReference: z.string().optional(),
});

export const transitionOrderStatusWorkflow = workflow<
  [z.input<typeof transitionStatusSchema>, { actorUserId?: string | null }],
  { orderId: string; toStatus: string }
>("order.transition_status", async (input, { actorUserId }) => {
  const parsed = transitionStatusSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  // Fail-CLOSED gateway pre-flight for cancelling a PENDING order: a pending
  // online order may hold a paid-but-unsettled capture (missed webhook), and
  // cancelling it would restock + reverse promos while the shop keeps the
  // money. Enforced HERE so every entry point gets it — incl. the external
  // PATCH /api/orders/[id]/status, which calls this workflow directly (the
  // admin/customer actions + the sweep also pre-check; the repeat is harmless).
  // COD / reference-less orders short-circuit without network I/O. Runs BEFORE
  // the tx: it does network I/O and, on a genuine capture, SETTLES the order via
  // confirmPaymentWorkflow → this workflow (to `paid`), which needs the same row
  // lock — it must never run while this workflow holds it.
  let verifiedPendingCancel = false;
  if (parsed.data.toStatus === "cancelled") {
    const current = await orderService.findById(parsed.data.orderId);
    if (current?.status === "pending") {
      const safety = await assertPendingOnlineOrderNotCaptured(current, { actorUserId });
      if (!safety.ok) {
        // already_paid / payment_detected are current-state conflicts (409 on
        // the API); payment_unverified is transient (retry later).
        return fail(safety.error === "payment_unverified" ? safety.error : "conflict", safety.message);
      }
      verifiedPendingCancel = true;
    }
  }

  // The cancel restock's stock mode (global variant-stock default), resolved
  // BEFORE the tx like place-order / returns / edit-items: read inside it, a
  // cold cache would take a second pool connection while this tx holds one plus
  // the order/stock locks (pool deadlock under concurrent cancels). Everything
  // the tx calls below runs on `tx`.
  const sharedDefault = parsed.data.toStatus === "cancelled" ? await getSharedStockDefault() : false;

  // Wrap the entire mutation set — payment-reference backfill, status
  // transition, history insert, refund-presence guard — in a single
  // transaction so partial states never reach the database. A rollback
  // un-persists every write.
  const result = await db.transaction<
    | {
        kind: "ok";
        updated: NonNullable<Awaited<ReturnType<typeof orderService.findById>>>;
        fromStatus: string;
        restock: RestockOutcome | null;
        /** THIS transition stamped `paid_at` (payment settled now). */
        settledNow: boolean;
      }
    | { kind: "fail"; error: WorkflowFail }
  >(async (tx) => {
    // Lock the order row inside the tx so the status guard is race-safe: a
    // concurrent transition blocks here until this one commits, eliminating
    // the check-then-update TOCTOU on `existing.status`.
    const existing = await orderService.findById(parsed.data.orderId, tx, {
      forUpdate: true,
    });
    if (!existing) {
      return { kind: "fail", error: fail("not_found", "Commande introuvable.") };
    }
    // The pre-flight above verified a PENDING order; if it moved meanwhile (e.g.
    // the webhook settled it to `paid`), that verdict no longer applies.
    if (verifiedPendingCancel && existing.status !== "pending") {
      return {
        kind: "fail",
        error: fail(
          "conflict",
          "Le statut de la commande a changé pendant la vérification du paiement — rechargez la page puis réessayez.",
        ),
      };
    }

    // Authoritative state-machine guard — re-validate the requested transition
    // against the payment-method-aware graph inside the locked tx, so the SERVER
    // (not just the client status-controls) is the source of truth. COD orders
    // skip the upfront `paid` gate (settle at delivery); online orders keep it.
    // Terminal states (cancelled / refunded) allow no transitions, so a
    // cancelled order can never be re-opened — which would ship units that
    // cancellation already restocked — and illegal jumps (e.g. pending→delivered)
    // are rejected.
    const allowedNext = orderTransitionsFor(
      existing.status as OrderStatus,
      existing.payment_method,
      existing.delivery_method,
    );
    if (!allowedNext.includes(parsed.data.toStatus)) {
      return {
        kind: "fail",
        error: fail(
          "invalid_transition",
          `Transition non autorisée : ${existing.status} → ${parsed.data.toStatus}.`,
        ),
      };
    }

    // A FULL refund of an order whose goods never left already restocked every
    // unit (refund-order.ts) without changing the status. Moving it forward
    // (preparing / shipped / delivered…) would ship goods the stock counter says
    // are back on the shelf. Only cancel / refunded stay reachable. An order
    // whose goods already (partly) left is unaffected — its remainder restock
    // and shipment guards live in refund-order / create-shipment.
    if (FORWARD_STATUSES.has(parsed.data.toStatus)) {
      const refundedCents = sumRefundCents(await orderService.listRefunds(parsed.data.orderId, tx));
      if (
        isFullyRefunded(existing.total_cents, refundedCents) &&
        !(await goodsLeftWarehouse(existing, tx))
      ) {
        return {
          kind: "fail",
          error: fail(
            "conflict",
            "Commande intégralement remboursée avant expédition — son stock a déjà été réintégré : elle ne peut plus avancer (annulez-la ou marquez-la « Remboursée »).",
          ),
        };
      }
    }

    // ANY transition to `refunded` requires a FULL refund on the ledger. The refund
    // ledger is the source of truth for "money was actually returned"; flipping the
    // status without it leaves an audit gap. And it must be FULL, not just ≥1 row:
    // `revenueOrderSql` excludes status IN (cancelled, refunded) ENTIRELY (not
    // net-of-refunds), so relabelling a PARTIALLY-refunded order « Remboursée » would
    // silently drop its still-valid un-refunded revenue too — and the promotion
    // reversal only fires on a full undo (the cancel branch / refund-order's
    // full-undo path), never on this flip. The status controls expose paid→refunded
    // and shipped→refunded (not just delivered→refunded) and already hide the button
    // unless fully refunded; enforce the SAME rule server-side so the external PATCH
    // /status route and scripted admin actions can't bypass it and strand a partial
    // refund as « Remboursée ».
    if (parsed.data.toStatus === "refunded") {
      const refunds = await orderService.listRefundsInTx(tx, parsed.data.orderId);
      if (refunds.length === 0) {
        return {
          kind: "fail",
          error: fail(
            "refund_required",
            "Enregistrez d'abord un remboursement avant de marquer la commande comme remboursée.",
          ),
        };
      }
      if (!isFullyRefunded(existing.total_cents, sumRefundCents(refunds))) {
        return {
          kind: "fail",
          error: fail(
            "conflict",
            "Remboursement partiel : la commande ne peut pas être marquée « Remboursée » tant que le remboursement n'est pas total. Effectuez un remboursement complet (ou gérez le reliquat via un retour).",
          ),
        };
      }
    }

    // Block cancellation once any parcel has shipped — the cancel restock below
    // restocks each line's FULL quantity, which would wrongly re-add units that
    // physically left in a bon de livraison. MUST run BEFORE transitionStatusInTx:
    // returning a fail commits the tx, so a post-transition guard would persist
    // the status change it meant to block. A partially-shipped order is handled
    // via returns, not cancellation.
    if (parsed.data.toStatus === "cancelled" && existing.status !== "cancelled") {
      const shipmentCount = await orderService.countShipments(parsed.data.orderId, tx);
      if (shipmentCount > 0) {
        return {
          kind: "fail",
          error: fail(
            "conflict",
            "Des expéditions (bons de livraison) existent déjà — gérez via un retour plutôt qu'une annulation.",
          ),
        };
      }
    }

    // Persist the gateway tx id before transitioning so subscribers reading
    // the row after the status change see a consistent picture.
    if (parsed.data.paymentReference) {
      await orderService.updatePaymentReference(
        parsed.data.orderId,
        parsed.data.paymentReference,
        undefined,
        tx,
      );
    }

    const updated = await orderService.transitionStatusInTx(
      tx,
      parsed.data.orderId,
      parsed.data.toStatus,
      actorUserId ?? undefined,
      parsed.data.notes,
    );
    if (!updated) {
      return { kind: "fail", error: fail("not_found", "Commande introuvable.") };
    }

    // Restock on cancellation — the mirror of the decrement at order creation
    // (place-order.ts), via the shared `restockOrderLines` helper. Cancellation
    // is only reachable from pre-ship states (pending / paid / preparing — the
    // shipped-guard above blocks it once a parcel left), so the units never left
    // the warehouse and are safe to return. `cancelled` is terminal, so this
    // can't double-restock. A FULL refund of an unshipped order restocks through
    // the SAME helper (refund-order.ts); a refund of shipped goods does NOT
    // auto-restock — recovery there goes through the Returns (SAV) flow.
    let restockOutcome: RestockOutcome | null = null;
    if (parsed.data.toStatus === "cancelled" && existing.status !== "cancelled") {
      // Restock the full line quantities (shared helper, also used by the
      // full-refund-of-unshipped path). Safe here because cancellation is
      // blocked once any parcel shipped (guard above), so the units never
      // physically left.
      //
      // DOUBLE-RESTOCK GUARD: a prior FULL refund of this (still-unshipped) order
      // already restocked the lines through the SAME additive (non-idempotent)
      // helper. The refund path writes no status change, so a paid→cancelled
      // transition is still reachable afterwards — restocking again would inflate
      // stock by a second full quantity (phantom sellable units → oversell). Skip
      // the restock when cumulative refunds already cover the refundable CEILING
      // (= total_cents): a prior FULL refund reaches that ceiling, so the cancel
      // must not restock a second time.
      const refunds = await orderService.listRefunds(parsed.data.orderId, tx);
      const refundedCents = refunds.reduce((acc, r) => acc + r.amount_cents, 0);
      const restockCeiling = existing.total_cents;
      const alreadyRestockedByRefund = restockCeiling > 0 && refundedCents >= restockCeiling;
      if (!alreadyRestockedByRefund) {
        restockOutcome = await restockOrderLines(tx, parsed.data.orderId, "cancellation", actorUserId, {
          sharedDefault,
        });
      }

      // Reverse promotion effects (P2 fix): free the coupon slot — the same
      // reconciliation a full refund performs. Runs on this tx so it is atomic
      // with the status transition + restock; idempotent guards make it safe
      // even though `cancelled` is terminal (can't double-apply).
      await reconcileOrderPromos(tx, updated);
    }

    return {
      kind: "ok",
      updated,
      fromStatus: existing.status,
      restock: restockOutcome,
      settledNow: existing.paid_at == null && updated.paid_at != null,
    };
  });

  if (result.kind === "fail") return result.error;

  const { updated, fromStatus, restock, settledNow } = result;

  // Post-commit: bust catalog/search cache + fire the back-in-stock waitlist for
  // any product the cancellation returned to stock (bus side effects can't run in
  // the tx). Best-effort — a notify hiccup must not fail the (already-committed)
  // cancellation.
  if (restock) await emitRestockEvents(restock, actorUserId).catch(() => {});

  await bus.emit(
    "order.status_changed",
    {
      orderId: updated.id,
      orderNumber: updated.order_number,
      fromStatus,
      toStatus: parsed.data.toStatus,
    },
    { actorUserId: actorUserId ?? null },
  );

  // `order.paid` = the payment SETTLED — emitted whenever this transition stamps
  // `paid_at`, not only on `→ paid`: a COD order settles at `delivered` (cash
  // collected on the doorstep, stamped by transitionStatusInTx), and ERP /
  // webhook consumers of order.paid must see that revenue too. `settledAt` tells
  // them how, from the order's payment method: "gateway" for an online-gateway
  // order (Flouci / ClicToPay), "manual" for an operator-recorded offline payment
  // (cash / virement), "delivery" for cash collected at delivery. A `→ paid` on
  // an already-stamped row keeps its legacy emit (consumers are idempotent).
  if (parsed.data.toStatus === "paid" || settledNow) {
    const settledAt =
      parsed.data.toStatus === "paid"
        ? isOnlineMethod(updated.payment_method)
          ? ("gateway" as const)
          : ("manual" as const)
        : ("delivery" as const);
    await bus.emit(
      "order.paid",
      { orderId: updated.id, orderNumber: updated.order_number, totalCents: updated.total_cents, settledAt },
      { actorUserId: actorUserId ?? null },
    );
  }

  return ok({ orderId: updated.id, toStatus: parsed.data.toStatus });
});
