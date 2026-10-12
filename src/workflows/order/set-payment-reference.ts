import "server-only";

import { z } from "zod";

import { db } from "@/lib/db/client";
import { orderService } from "@/modules/order/service";
import { paymentMethodEnum } from "@/modules/order/schema";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";
import type { WorkflowFail } from "../shared";

/**
 * Whether the payment METHOD may still be switched. The method picks the
 * settlement point (`paid_at` is stamped at `paid` for upfront methods, at
 * `delivered` for COD), so switching an order that left `pending` UNSETTLED —
 * e.g. a shipped COD order to cash — would make the delivery never stamp
 * `paid_at` (never "paid", never refundable). Locked only in that window:
 *   - still `pending` → free (the graph is chosen from here on);
 *   - already settled (`paid_at` set) → free: it's never re-stamped, and the
 *     upfront/COD graphs are identical past `pending` (e.g. correcting a manual
 *     order recorded « Espèces » that was really a « Virement »).
 * The reference itself stays correctable. Shared with the admin order page.
 */
export function isPaymentMethodEditable(order: { status: string; paid_at: Date | null }): boolean {
  return order.status === "pending" || order.paid_at != null;
}

/**
 * Admin-side "set payment method + reference" for an order. Used when a
 * payment lands outside the gateway (wire transfer, in-person cash, etc.)
 * and the operator needs to backfill the receipt fields without forcing a
 * status transition.
 */
export const setOrderPaymentReferenceSchema = z.object({
  orderId: z.string().uuid(),
  // Accept an untrusted string but REFINE it to the pg enum values, so a
  // free-text method (e.g. "chèque") returns a clean fail("validation") instead
  // of a 22P02 invalid_text_representation 500 on the orders.payment_method enum
  // column. (A plain z.enum would over-narrow the workflow input type vs the
  // string the action boundary passes.)
  paymentMethod: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine(
      (v) => (paymentMethodEnum.enumValues as readonly string[]).includes(v),
      "Méthode de paiement invalide.",
    )
    .optional()
    .nullable(),
  paymentReference: z.string().trim().min(1).max(120),
});

export const setOrderPaymentReferenceWorkflow = workflow<
  [z.input<typeof setOrderPaymentReferenceSchema>, { actorUserId: string }],
  { orderId: string }
>("order.set_payment_reference", async (input, { actorUserId }) => {
  const parsed = setOrderPaymentReferenceSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  // Locked read + guard + write in one tx so a concurrent status change can't
  // slip between the method-lock check and the update.
  const result = await db.transaction<
    | { kind: "ok"; updated: NonNullable<Awaited<ReturnType<typeof orderService.updatePaymentReference>>> }
    | { kind: "fail"; error: WorkflowFail }
  >(async (tx) => {
    const existing = await orderService.findById(parsed.data.orderId, tx, { forUpdate: true });
    if (!existing) return { kind: "fail", error: fail("not_found", "Commande introuvable.") };

    // Re-sending the CURRENT method is a no-op, not a change (the admin form
    // pre-fills it), so only an actual switch is subject to the lock.
    const requestedMethod = parsed.data.paymentMethod ?? undefined;
    const methodChanges = requestedMethod !== undefined && requestedMethod !== existing.payment_method;
    if (methodChanges && !isPaymentMethodEditable(existing)) {
      return {
        kind: "fail",
        error: fail(
          "conflict",
          "La méthode de paiement ne peut plus être changée : la commande est sortie de « En attente » sans être réglée (le règlement dépend de la méthode) — seule la référence peut être corrigée.",
        ),
      };
    }

    const updated = await orderService.updatePaymentReference(
      parsed.data.orderId,
      parsed.data.paymentReference,
      methodChanges ? requestedMethod : undefined,
      tx,
    );
    if (!updated) return { kind: "fail", error: fail("not_found", "Commande introuvable.") };
    return { kind: "ok", updated };
  });
  if (result.kind === "fail") return result.error;
  const { updated } = result;

  await bus.emit(
    "order.payment_reference_updated",
    {
      orderId: updated.id,
      orderNumber: updated.order_number,
      paymentMethod: updated.payment_method ?? null,
    },
    { actorUserId },
  );

  return ok({ orderId: updated.id });
});
