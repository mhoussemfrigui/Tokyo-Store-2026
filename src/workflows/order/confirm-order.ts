import "server-only";

import { z } from "zod";

import { orderService } from "@/modules/order/service";
import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";
import type { WorkflowFail } from "../shared";

export const confirmOrderSchema = z.object({ orderId: z.string().uuid() });

/**
 * Operator "Confirmer la commande" — accept a placed order so its stepper reads
 * "Confirmée". Used for COD orders (online orders auto-confirm when they settle
 * to `paid`, via transitionStatusInTx). Sets `confirmed_at` only — the status is
 * unchanged — inside a row-locked tx, then emits `order.confirmed` (drives the
 * confirmation email). Idempotent: a second call on an already-confirmed order
 * is a no-op (no duplicate event). Terminal orders (cancelled/refunded) reject.
 */
export const confirmOrderWorkflow = workflow<
  [z.input<typeof confirmOrderSchema>, { actorUserId?: string | null }],
  { orderId: string; alreadyConfirmed: boolean }
>("order.confirm", async (input, { actorUserId }) => {
  const parsed = confirmOrderSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  const result = await db.transaction<
    | { kind: "ok"; orderId: string; orderNumber: string; already: boolean }
    | { kind: "fail"; error: WorkflowFail }
  >(async (tx) => {
    const existing = await orderService.findById(parsed.data.orderId, tx, { forUpdate: true });
    if (!existing) return { kind: "fail", error: fail("not_found", "Commande introuvable.") };
    if (existing.status === "cancelled" || existing.status === "refunded") {
      return {
        kind: "fail",
        error: fail("conflict", "Commande terminée — confirmation impossible."),
      };
    }
    if (existing.confirmed_at != null) {
      return { kind: "ok", orderId: existing.id, orderNumber: existing.order_number, already: true };
    }
    const updated = await orderService.confirmOrderInTx(
      tx,
      parsed.data.orderId,
      actorUserId ?? undefined,
    );
    if (!updated) return { kind: "fail", error: fail("not_found", "Commande introuvable.") };
    return { kind: "ok", orderId: updated.id, orderNumber: updated.order_number, already: false };
  });

  if (result.kind === "fail") return result.error;

  // Post-commit: fire the confirmation email exactly once (skip if it was
  // already confirmed — no duplicate notification).
  if (!result.already) {
    await bus.emit(
      "order.confirmed",
      { orderId: result.orderId, orderNumber: result.orderNumber },
      { actorUserId: actorUserId ?? null },
    );
  }

  return ok({ orderId: result.orderId, alreadyConfirmed: result.already });
});
