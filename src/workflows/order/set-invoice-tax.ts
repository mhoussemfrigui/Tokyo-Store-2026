import "server-only";

import { z } from "zod";
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { orders, order_status_history } from "@/modules/order/schema";
import { orderService } from "@/modules/order/service";
import { getTaxConfigStrict, type TaxMode } from "@/lib/tax";
import { recomputeOrderTotals } from "@/lib/order/recompute-totals";
import { documentShippingTaxCents, sumCareCents, sumCareTaxCents } from "@/lib/order/document-money";
import { orderChargesTaxOnTop, orderTotalLock } from "@/lib/order/order-tax-mode";
import { formatMoneyExact } from "@/lib/price";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";
import type { WorkflowFail } from "../shared";

/** Statuses whose amount-to-collect may still move (mirrors edit-items). */
const PRE_SHIP = new Set(["pending", "paid", "preparing"]);

/** Upper bound for a manual TVA (1 000 000 TND in millimes) — keeps the rebuilt
 *  total inside the int4 `*_cents` columns. */
const MAX_TAX_CENTS = 1_000_000_000;

export const setInvoiceTaxSchema = z.discriminatedUnion("mode", [
  z.object({
    orderId: z.string().uuid(),
    mode: z.literal("manual"),
    amountCents: z.number().int().min(0).max(MAX_TAX_CENTS),
  }),
  z.object({ orderId: z.string().uuid(), mode: z.literal("global") }),
]);

/** The order columns the TVA decision reads (a subset of OrderRow). */
export type InvoiceTaxOrder = {
  status: string;
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  tax_manual_cents: number | null;
  total_cents: number;
  /** Tokyo Care add-on charge (ex-TVA) — PRESERVED in the rebuilt total base. */
  care_cents: number;
  paid_at: Date | null;
  payment_method: string | null;
  payment_reference: string | null;
  invoice_number: string | null;
  credit_note_number: string | null;
};

// The order-level TVA rules now live in the PURE `@/lib/order/order-tax-mode`
// (shared with edit-items + the ERP API). Re-exported here: the admin order page,
// the orders CSV export and invoice-tax.test.ts import it from this module.
export { orderChargesTaxOnTop };

export type InvoiceTaxPlan =
  | {
      kind: "ok";
      taxCents: number;
      taxManualCents: number | null;
      totalCents: number;
      totalChanged: boolean;
      /** False when the request leaves every column as it is (no write, no event). */
      changed: boolean;
    }
  | { kind: "refuse"; error: WorkflowFail };

/**
 * PURE decision for an invoice-TVA change on a (locked) order row.
 *
 *   - `next.taxManualCents` set → manual override of the printed TVA;
 *     null → back to the computed `next.taxCents` (the "Recalculer" path).
 *   - Fiscal lock: once an invoice / credit note is numbered the printed TVA is
 *     frozen (same rule as edit-items) — the correction goes through an avoir.
 *   - The total only moves when the TVA is charged ON TOP, and only while the
 *     amount is still to collect: never on a settled order (`paid_at` is the
 *     captured amount — refunds are capped on it), never once shipped (the
 *     courier already carries the amount), never under an in-flight gateway
 *     payment (the capture would then mismatch and be refused). The rebuilt
 *     total is clamped at 0 like place-order.
 */
export function planInvoiceTaxChange(
  order: InvoiceTaxOrder,
  next: { taxCents: number; taxManualCents: number | null },
  liveMode: TaxMode,
): InvoiceTaxPlan {
  if (order.invoice_number || order.credit_note_number) {
    return {
      kind: "refuse",
      error: fail("conflict", "Facture déjà émise — émettez un avoir avant de corriger la TVA."),
    };
  }

  const effective = next.taxManualCents ?? next.taxCents;
  const onTop = orderChargesTaxOnTop(order, liveMode);
  // Tokyo Care is a preserved charge in the base (like shipping), so a TVA tweak
  // never drops it from the rebuilt total.
  const netWithShipping =
    order.subtotal_cents - order.discount_cents + order.shipping_cents + order.care_cents;
  const totalCents = onTop ? Math.max(0, netWithShipping + effective) : order.total_cents;
  const totalChanged = totalCents !== order.total_cents;

  if (totalChanged) {
    // The shared total-lock rule (same predicate as edit-items).
    const lock = orderTotalLock(order);
    if (lock === "settled") {
      return {
        kind: "refuse",
        error: fail(
          "conflict",
          "Commande déjà réglée : la TVA s'ajoute au total, qui ne peut plus changer après encaissement — émettez un avoir.",
        ),
      };
    }
    if (!PRE_SHIP.has(order.status)) {
      return {
        kind: "refuse",
        error: fail(
          "invalid_status",
          "Commande expédiée ou clôturée : la TVA s'ajoute au total, dont le montant à encaisser ne peut plus changer.",
        ),
      };
    }
    if (lock === "gateway_pending") {
      return {
        kind: "refuse",
        error: fail(
          "conflict",
          "Paiement en ligne en cours : le total ne peut pas changer tant que le règlement n'est pas finalisé.",
        ),
      };
    }
  }

  const changed =
    next.taxCents !== order.tax_cents ||
    next.taxManualCents !== order.tax_manual_cents ||
    totalChanged;
  return {
    kind: "ok",
    taxCents: next.taxCents,
    taxManualCents: next.taxManualCents,
    totalCents,
    totalChanged,
    changed,
  };
}

/**
 * Per-order invoice TVA control (manual override / recompute) — the admin
 * "TVA facture" form.
 *
 *   • "manual" → `tax_manual_cents = amountCents`: the operator corrects the
 *     printed TVA (rounding, a manual ledger value…).
 *   • "global" → re-sum the per-line TVA snapshots (`order_items.tax_cents`,
 *     resolved through the full cascade at sale time) plus the order's OWN
 *     shipping-tax term (`tax_cents − Σ line tax`, never the live rate /
 *     on_shipping flag), and CLEAR the override — restoring the accurate sale
 *     TVA (never a flat global rate on the discounted base).
 *
 * Locked read + guard + write in ONE transaction (a concurrent line edit can't
 * slip between the read and the write), refused once the invoice is numbered,
 * and audited: a same-status history row on the order timeline plus
 * `order.edited` (→ audit_log + outbound webhooks) with the actor. The total
 * rules live in {@link planInvoiceTaxChange}. Refused only when there is no TVA
 * to correct: the store's TVA is disabled AND the order carries none — an order
 * sold with TVA stays correctable after the store later turns TVA off.
 */
export const setOrderInvoiceTaxWorkflow = workflow<
  [z.input<typeof setInvoiceTaxSchema>, { actorUserId: string }],
  { orderId: string; changed: boolean; totalChanged: boolean }
>("order.set_invoice_tax", async (input, { actorUserId }) => {
  const parsed = setInvoiceTaxSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Montant de TVA invalide.");
  const d = parsed.data;

  // STRICT read: a failed settings read throws (→ workflow() "internal",
  // retryable) instead of resolving to mode "disabled".
  const config = await getTaxConfigStrict();

  type TxResult =
    | {
        kind: "ok";
        orderNumber: string;
        changed: boolean;
        totalChanged: boolean;
      }
    | { kind: "fail"; error: WorkflowFail };

  const result = await db.transaction<TxResult>(async (tx) => {
    const order = await orderService.findById(d.orderId, tx, { forUpdate: true });
    if (!order) return { kind: "fail", error: fail("not_found", "Commande introuvable.") };
    // Gated on the ORDER carrying TVA, not only on the live mode: a historical
    // order sold with TVA keeps a correctable invoice TVA after the store turns
    // TVA off. (Read-only so far — a returned fail commits nothing.)
    const orderCarriesTax = order.tax_cents > 0 || order.tax_manual_cents != null;
    if (config.mode === "disabled" && !orderCarriesTax) {
      return {
        kind: "fail",
        error: fail("tax_disabled", "La TVA est désactivée dans les réglages : aucune TVA de facture à corriger."),
      };
    }

    // Tokyo Care snapshot — preserved through any invoice-TVA change (the add-on
    // charge stays on the total; its TVA is part of tax_cents and must not be
    // double-counted as shipping tax, nor dropped on a "Recalculer").
    const careItems = await orderService.listCareItems(d.orderId, tx);
    const careCents = sumCareCents(careItems);
    const careTaxCents = sumCareTaxCents(careItems);

    let next: { taxCents: number; taxManualCents: number | null };
    if (d.mode === "manual") {
      next = { taxCents: order.tax_cents, taxManualCents: d.amountCents };
    } else {
      // The sale TVA through the shared totals helper (per-line snapshots +
      // shipping term). Only its TAX figure is used: the helper decides "tax on
      // top" from its taxMode, whereas this order's own arithmetic decides it
      // here (planInvoiceTaxChange). The shipping term is the ORDER's own
      // (`tax_cents − Σ line tax`, as sold) — never re-derived from the live
      // rate / on_shipping flag, which may have changed since the sale.
      const lines = await orderService.listItemsInTx(tx, d.orderId);
      const recomputed = recomputeOrderTotals({
        lines: lines.map((l) => ({ unitPriceCents: l.unit_price_cents, quantity: l.quantity, taxCents: l.tax_cents })),
        shippingCents: order.shipping_cents,
        discountCents: order.discount_cents,
        taxMode: orderChargesTaxOnTop(order, config.mode) ? "ht" : "ttc",
        taxDefaultRateBps: config.defaultRateBps,
        taxOnShipping: config.onShipping,
        shippingTaxCents: documentShippingTaxCents(order, lines, careTaxCents),
        careCents,
        careTaxCents,
      });
      next = { taxCents: recomputed.taxCents, taxManualCents: null };
    }

    const plan = planInvoiceTaxChange(order, next, config.mode);
    if (plan.kind === "refuse") return { kind: "fail", error: plan.error };
    if (!plan.changed) {
      return { kind: "ok", orderNumber: order.order_number, changed: false, totalChanged: false };
    }

    await tx
      .update(orders)
      .set({
        tax_cents: plan.taxCents,
        tax_manual_cents: plan.taxManualCents,
        total_cents: plan.totalCents,
        updated_at: sql`now()`,
      })
      .where(eq(orders.id, order.id));

    // Timeline trace (same-status row, like an edit-items change).
    const before = order.tax_manual_cents ?? order.tax_cents;
    const after = plan.taxManualCents ?? plan.taxCents;
    const how = plan.taxManualCents != null ? "saisie manuelle" : "recalculée";
    const totalNote = plan.totalChanged
      ? ` — total ${formatMoneyExact(order.total_cents)} → ${formatMoneyExact(plan.totalCents)}`
      : "";
    await tx.insert(order_status_history).values({
      order_id: order.id,
      from_status: order.status,
      to_status: order.status,
      actor_user_id: actorUserId,
      notes: `${config.label} facture : ${formatMoneyExact(before)} → ${formatMoneyExact(after)} (${how})${totalNote}`,
    });

    return { kind: "ok", orderNumber: order.order_number, changed: true, totalChanged: plan.totalChanged };
  });
  if (result.kind === "fail") return result.error;

  if (result.changed) {
    await bus.emit(
      "order.edited",
      {
        orderId: d.orderId,
        orderNumber: result.orderNumber,
        changedFields: result.totalChanged
          ? ["tax_cents", "tax_manual_cents", "total_cents"]
          : ["tax_cents", "tax_manual_cents"],
        actorUserId,
      },
      { actorUserId },
    );
  }

  return ok({ orderId: d.orderId, changed: result.changed, totalChanged: result.totalChanged });
});
