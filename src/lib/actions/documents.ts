"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";

import { bus } from "@/events/bus";
import { db } from "@/lib/db/client";
import { orders } from "@/modules/order/schema";
import { orderService } from "@/modules/order/service";
import { documentService, DOCUMENT_PREFIX_DEFAULTS } from "@/modules/document";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { requirePermission } from "@/lib/auth/session";
import { fiscalYear } from "@/lib/fiscal-period";
import { ensureOrderDeliveryNoteNumber } from "@/lib/order/issue-delivery-note";
import { goodsLeftWarehouse, isFullyRefunded, sumRefundCents } from "@/lib/order/fulfilment-state";
import { type ActionState } from "@/lib/actions/types";

/** Sanitize an operator-set prefix to A–Z/0–9, fall back to the default. */
function prefixOf(raw: string | null | undefined, fallback: string): string {
  const cleaned = (raw ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.slice(0, 8) || fallback;
}

/** Year bucket for per-year gapless numbering — store timezone (Africa/Tunis),
 *  not the raw UTC server clock (see fiscal-period.ts). */
function currentPeriod(): string {
  return fiscalYear();
}

/**
 * Issue (stamp) the fiscal invoice number on an order. Idempotent: if the order
 * already has an `invoice_number`, returns it unchanged. Draws a gapless number
 * from `document_sequences` inside the SAME tx as the stamp, under a row lock on
 * the order, so a rollback never burns a number and two clicks can't double-issue.
 */
export async function issueInvoiceAction(orderId: string): Promise<ActionState> {
  const session = await requirePermission("orders", "manage");
  const settings = await getSettingsMap();
  const prefix = prefixOf(settings["invoice.number_prefix"], DOCUMENT_PREFIX_DEFAULTS.invoice);
  const period = currentPeriod();

  const outcome = await db.transaction(async (tx): Promise<{ number: string; orderNumber: string } | null> => {
    const order = await orderService.findById(orderId, tx, { forUpdate: true });
    if (!order) return null;
    if (order.invoice_number) return { number: order.invoice_number, orderNumber: order.order_number };
    const number = await documentService.nextNumber("invoice", { prefix, period }, tx);
    await tx
      .update(orders)
      .set({ invoice_number: number, invoiced_at: sql`now()`, updated_at: sql`now()` })
      .where(eq(orders.id, orderId));
    return { number, orderNumber: order.order_number };
  });

  if (!outcome) return { ok: false, error: "not_found", message: "Commande introuvable." };
  await bus.emit(
    "order.invoice_issued",
    { orderId, orderNumber: outcome.orderNumber, invoiceNumber: outcome.number },
    { actorUserId: session.user.id },
  );
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, message: `Facture émise : ${outcome.number}` };
}

/**
 * Issue an avoir (credit note) number on an order. Requires at least one row in
 * `order_refunds` (a credit note documents money returned). Idempotent + gapless,
 * same atomic discipline as the invoice.
 */
export async function issueCreditNoteAction(orderId: string): Promise<ActionState> {
  const session = await requirePermission("orders", "manage");
  const refunds = await orderService.listRefunds(orderId);
  if (refunds.length === 0) {
    return { ok: false, error: "refund_required", message: "Enregistrez d'abord un remboursement avant d'émettre un avoir." };
  }
  const settings = await getSettingsMap();
  const prefix = prefixOf(settings["invoice.credit_prefix"], DOCUMENT_PREFIX_DEFAULTS.credit_note);
  const period = currentPeriod();

  const outcome = await db.transaction(async (tx): Promise<{ number: string; orderNumber: string } | null> => {
    const order = await orderService.findById(orderId, tx, { forUpdate: true });
    if (!order) return null;
    if (order.credit_note_number) return { number: order.credit_note_number, orderNumber: order.order_number };
    const number = await documentService.nextNumber("credit_note", { prefix, period }, tx);
    // Snapshot the refunded total UNDER THE ORDER LOCK so the printed avoir shows
    // the amount as of issuance — a later refund won't mutate this numbered doc.
    const refundedAtIssue = sumRefundCents(await orderService.listRefundsInTx(tx, orderId));
    await tx
      .update(orders)
      .set({
        credit_note_number: number,
        credit_note_at: sql`now()`,
        credit_note_amount_cents: refundedAtIssue,
        updated_at: sql`now()`,
      })
      .where(eq(orders.id, orderId));
    return { number, orderNumber: order.order_number };
  });

  if (!outcome) return { ok: false, error: "not_found", message: "Commande introuvable." };
  await bus.emit(
    "order.credit_note_issued",
    { orderId, orderNumber: outcome.orderNumber, creditNoteNumber: outcome.number },
    { actorUserId: session.user.id },
  );
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, message: `Avoir émis : ${outcome.number}` };
}

/**
 * Issue a bon de livraison (delivery note) number on an order. Gapless +
 * idempotent, same atomic discipline. The printable BL itself carries no prices
 * (logistics doc) and lives at /admin/orders/[id]/delivery-note.
 *
 * Refused (no number drawn) when the goods are already covered or never left:
 *   - the order was fulfilled through parcels — each shipment already carries
 *     its own BL number from the SAME counter (checked under the order lock,
 *     like the auto-issue-on-ship subscriber);
 *   - the order is fully refunded and was never shipped — the refund already put
 *     its stock back, there is nothing to deliver.
 */
export async function issueDeliveryNoteAction(orderId: string): Promise<ActionState> {
  const session = await requirePermission("orders", "manage");
  const order = await orderService.findById(orderId);
  if (!order) return { ok: false, error: "not_found", message: "Commande introuvable." };
  if (!order.delivery_note_number) {
    const refundedCents = sumRefundCents(await orderService.listRefunds(orderId));
    if (isFullyRefunded(order.total_cents, refundedCents) && !(await goodsLeftWarehouse(order))) {
      return {
        ok: false,
        error: "conflict",
        message:
          "Commande intégralement remboursée avant expédition — aucun bon de livraison à émettre.",
      };
    }
  }
  // Shared idempotent core (also used by the auto-issue-on-ship subscriber), so
  // the manual + automatic paths use identical gapless numbering. The order
  // exists (read above), so a null outcome means it was skipped for its parcels.
  const outcome = await ensureOrderDeliveryNoteNumber(orderId, undefined, { skipIfShipments: true });
  if (!outcome) {
    return {
      ok: false,
      error: "conflict",
      message: "Cette commande a déjà des bons de livraison par colis.",
    };
  }
  // Only audit a FRESH issuance (idempotent re-stamps return the existing number).
  if (outcome.issued) {
    await bus.emit(
      "order.delivery_note_issued",
      { orderId, orderNumber: outcome.orderNumber, deliveryNoteNumber: outcome.number },
      { actorUserId: session.user.id },
    );
  }
  revalidatePath(`/admin/orders/${orderId}`);
  return { ok: true, message: `Bon de livraison émis : ${outcome.number}` };
}
