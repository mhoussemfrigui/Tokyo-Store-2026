import "server-only";

import { z } from "zod";

import { db } from "@/lib/db/client";
import { orderService } from "@/modules/order/service";
import { isOnlineMethod } from "@/lib/payments/shared";
import { bus } from "@/events/bus";
// Circular-safe: assertPendingOnlineOrderNotCaptured lives in gateway-payment,
// which imports this module's siblings only at call time (same pattern as
// transition-status). Dereferenced only inside the handler.
import { assertPendingOnlineOrderNotCaptured } from "./gateway-payment";
import { fail, ok, workflow } from "../shared";
import type { WorkflowFail } from "../shared";

/**
 * Switch a STUCK pending online-gateway order to cash-on-delivery.
 *
 * Use case: a customer placed an order with an online method (Flouci / ClicToPay)
 * but never completed the payment — the order is stranded in `pending` and the
 * abandoned-orders sweep will eventually cancel it. Rather than lose the sale, an
 * operator (after speaking to the customer) converts it to COD so it can be
 * prepared and settled at delivery.
 *
 * MONEY-SAFETY (fail-closed, mirrors the cancel path): only a `pending` order whose
 * gateway session is DEFINITIVELY dead may switch. A live session (customer might
 * be paying right now) or an actual capture must NOT be converted — switching a
 * captured order to COD would drop the online settlement and collect the cash
 * again at delivery (double payment). `assertPendingOnlineOrderNotCaptured`
 * re-verifies with the gateway before the tx and refuses:
 *   - `already_paid` / `payment_detected` → the money is there, settle to `paid`
 *     (409) instead of switching;
 *   - `payment_in_progress` → a session may still be open (503) — retry later.
 * Only failed / cancelled / expired sessions pass. COD (and other non-online)
 * orders are rejected as nothing-to-do.
 *
 * The order stays `pending` and now follows the COD transition graph (no upfront
 * `paid` gate; `paid_at` is stamped at `delivered`). `switchToCod` also clears the
 * dead `payment_reference`, so no late gateway webhook can match it by reference.
 * Emits `order.edited {changedFields:["payment_method"]}` (audited + webhooked).
 */
const switchToCodSchema = z.object({ orderId: z.string().uuid() });

export const switchOrderToCodWorkflow = workflow<
  [z.input<typeof switchToCodSchema>, { actorUserId?: string | null }],
  { orderId: string }
>("order.switch_to_cod", async (input, { actorUserId }) => {
  const parsed = switchToCodSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");

  // Pre-flight (network I/O) BEFORE the tx — it re-verifies with the gateway and,
  // on a live session, may itself settle the order via confirmPaymentWorkflow,
  // which needs the same row lock; it must never run while this tx holds it.
  const current = await orderService.findById(parsed.data.orderId);
  if (!current) return fail("not_found", "Commande introuvable.");
  if (current.status !== "pending") {
    return fail(
      "conflict",
      "Seule une commande « En attente » non réglée peut être basculée en paiement à la livraison.",
    );
  }
  if (!isOnlineMethod(current.payment_method)) {
    return fail(
      "conflict",
      "Cette commande n'utilise pas de paiement en ligne — rien à basculer.",
    );
  }
  const safety = await assertPendingOnlineOrderNotCaptured(current, { actorUserId });
  if (!safety.ok) {
    // TRANSIENT (retry later → 503): a live gateway session (`payment_in_progress`)
    // or an unverifiable gateway (`payment_unverified`) — we can't yet prove the
    // order is unpaid, so refuse fail-closed but let the operator retry. DEFINITIVE
    // (409): `already_paid` / `payment_detected` — the money is there, settle to
    // `paid` instead of downgrading to COD.
    const transient = safety.error === "payment_in_progress" || safety.error === "payment_unverified";
    return fail(transient ? "payment_unverified" : "conflict", safety.message);
  }

  // Lock + re-check + write in one tx: a concurrent settle (webhook → paid) could
  // land between the pre-flight and here, so re-assert `pending` + online under the
  // lock before converting.
  const result = await db.transaction<
    | { kind: "ok"; orderNumber: string }
    | { kind: "fail"; error: WorkflowFail }
  >(async (tx) => {
    const existing = await orderService.findById(parsed.data.orderId, tx, { forUpdate: true });
    if (!existing) return { kind: "fail", error: fail("not_found", "Commande introuvable.") };
    if (existing.status !== "pending" || !isOnlineMethod(existing.payment_method)) {
      return {
        kind: "fail",
        error: fail(
          "conflict",
          "Le statut ou le mode de paiement de la commande a changé — rechargez la page puis réessayez.",
        ),
      };
    }
    const updated = await orderService.switchToCod(parsed.data.orderId, tx);
    if (!updated) return { kind: "fail", error: fail("not_found", "Commande introuvable.") };
    return { kind: "ok", orderNumber: updated.order_number };
  });

  if (result.kind === "fail") return result.error;

  await bus.emit(
    "order.edited",
    {
      orderId: parsed.data.orderId,
      orderNumber: result.orderNumber,
      changedFields: ["payment_method"],
      actorUserId: actorUserId ?? null,
    },
    { actorUserId: actorUserId ?? null },
  );

  return ok({ orderId: parsed.data.orderId });
});
