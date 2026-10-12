import "server-only";

import { z } from "zod";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { orderService } from "@/modules/order/service";
import { type PaymentState } from "@/lib/order/payment-status";
import { fail, ok, workflow } from "../shared";
import type { WorkflowFail } from "../shared";

export const setOrderPaymentStatusSchema = z.object({
  orderId: z.string().uuid(),
  state: z.enum(["unpaid", "partial", "paid"]),
  /** Cash received so far (minor units), only read for `partial`. */
  amountCents: z.number().int().min(0).optional(),
});

/**
 * « Paiement manuel » — set an order's PAYMENT settlement directly, independent
 * of its fulfilment status. Gated upstream by the `orders.manual_payment_enabled`
 * setting + `orders:manage` (the action re-checks both).
 *
 *   paid    → stamp `paid_at` (if not already) + record the full amount due, and
 *             (post-commit) emit `order.paid` so revenue + the status email fire
 *             EXACTLY like a real gateway/COD settlement.
 *   partial → record the amount received (0 < X < due), `paid_at` stays null.
 *   unpaid  → clear `paid_at` + the amount.
 *
 * A `partial` amount ≥ due is promoted to `paid`; ≤ 0 is demoted to `unpaid`.
 * Refused on a cancelled/refunded order (payment there is a refund concern).
 */
export const setOrderPaymentStatusWorkflow = workflow<
  [z.input<typeof setOrderPaymentStatusSchema>, { actorUserId?: string | null }],
  { orderId: string; state: PaymentState; amountPaidCents: number | null }
>("order.set_payment_status", async (input, { actorUserId }) => {
  const parsed = setOrderPaymentStatusSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Données de paiement invalides.");
  const { orderId } = parsed.data;

  type TxOk = {
    kind: "ok";
    order: { id: string; order_number: string; total_cents: number; amount_paid_cents: number | null };
    state: PaymentState;
    emitPaid: boolean;
  };
  const result = await db.transaction<TxOk | { kind: "fail"; error: WorkflowFail }>(async (tx) => {
    // Lock the row so the earn/reverse decision + write are race-safe against a
    // concurrent transition (e.g. a webhook settling the order).
    const existing = await orderService.findById(orderId, tx, { forUpdate: true });
    if (!existing) return { kind: "fail", error: fail("not_found", "Commande introuvable.") };
    if (existing.status === "cancelled" || existing.status === "refunded") {
      return {
        kind: "fail",
        error: fail(
          "conflict",
          "Commande annulée ou remboursée — le paiement se gère via un remboursement, pas ici.",
        ),
      };
    }

    const due = existing.total_cents;
    const wasPaid = existing.paid_at != null;

    // Normalize the requested state against the amount: a partial ≥ due is really
    // a full payment; a partial ≤ 0 is really unpaid.
    let target: PaymentState = parsed.data.state;
    let partialAmount = 0;
    if (target === "partial") {
      const amt = parsed.data.amountCents ?? 0;
      if (amt <= 0) target = "unpaid";
      else if (amt >= due) target = "paid";
      else partialAmount = amt;
    }

    let newPaidAt: Date | null;
    let newAmountPaid: number | null;
    let note: string;
    let emitPaid = false;

    if (target === "paid") {
      newPaidAt = existing.paid_at ?? new Date();
      newAmountPaid = due;
      note = "Paiement marqué « Payée » (manuel).";
      emitPaid = !wasPaid; // settle only on the transition INTO paid
    } else if (target === "partial") {
      newPaidAt = null;
      newAmountPaid = partialAmount;
      note = "Paiement marqué « Partiellement payée » (manuel).";
    } else {
      newPaidAt = null;
      newAmountPaid = null;
      note = "Paiement marqué « Non payée » (manuel).";
    }

    const updated = await orderService.setManualPaymentInTx(tx, orderId, {
      paidAt: newPaidAt,
      amountPaidCents: newAmountPaid,
      note,
      actorUserId: actorUserId ?? null,
    });
    if (!updated) return { kind: "fail", error: fail("server", "La mise à jour du paiement a échoué.") };
    return { kind: "ok", order: updated, state: target, emitPaid };
  });

  if (result.kind === "fail") return result.error;

  // Post-commit (outside the tx): a fresh settlement → order.paid (revenue +
  // status email).
  if (result.emitPaid) {
    await bus.emit(
      "order.paid",
      {
        orderId: result.order.id,
        orderNumber: result.order.order_number,
        totalCents: result.order.total_cents,
        settledAt: "manual",
      },
      { actorUserId: actorUserId ?? null },
    );
  }

  return ok({
    orderId: result.order.id,
    state: result.state,
    amountPaidCents: result.order.amount_paid_cents,
  });
});
