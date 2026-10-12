/**
 * PURE order-level TVA + total-lock rules — NO "server-only", NO DB — shared by
 * the two writers that move an existing order's money (edit-items,
 * set-invoice-tax) and the readers that must interpret it the same way (the ERP
 * order API, the admin pages via the set-invoice-tax re-export). Orders store no
 * tax-mode snapshot, so every rule here reads the ORDER's own arithmetic, never
 * the live store config alone: a later store-wide switch (ttc ↔ ht, TVA turned
 * on/off, on_shipping toggled) must never re-interpret an existing order.
 */
import { isOnlineMethod } from "@/lib/payments/shared";
import type { TaxMode } from "@/lib/tax/shared";

/** The order money columns the TVA rules read (a subset of OrderRow). */
export type OrderTaxSnapshot = {
  subtotal_cents: number;
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  tax_manual_cents: number | null;
  total_cents: number;
  /** Tokyo Care add-on (ex-TVA) — part of the PRE-TAX base, so the ttc/ht
   *  inference stays correct on a protected order. Optional for legacy callers
   *  that predate care (treated as 0). */
  care_cents?: number;
};

/** The pre-TVA total an order was built from: goods + shipping + care − discount.
 *  Comparing it to `total_cents` reveals whether the TVA sits on top (ht) or is
 *  embedded (ttc). Care MUST be here or a ttc protected order reads as ht. */
function preTaxBaseCents(order: OrderTaxSnapshot): number {
  return (
    order.subtotal_cents + order.shipping_cents + (order.care_cents ?? 0) - order.discount_cents
  );
}

/**
 * Whether the order's stored total CARRIES its TVA on top (a tax-exclusive "ht"
 * sale) rather than including it ("ttc" — an informational extract). Inferred
 * from the order's OWN arithmetic — the same rule as the admin order + invoice
 * pages (`taxIncludedInTotal`) — so a later store-wide mode switch can't
 * re-interpret an old order (a ttc-era order must never get its TVA added on top
 * after the store moves to ht). Only an order carrying no TVA at all gives no
 * signal; it falls back to the live mode.
 */
export function orderChargesTaxOnTop(order: OrderTaxSnapshot, liveMode: TaxMode): boolean {
  const effective = order.tax_manual_cents ?? order.tax_cents;
  if (effective > 0) {
    return preTaxBaseCents(order) !== order.total_cents;
  }
  return liveMode === "ht";
}

/**
 * Whether the printed TVA (`tax_manual_cents ?? tax_cents`) is already INSIDE
 * `total_cents` — the renderers' `taxIncludedInTotal` rule, exposed to the ERP
 * API so a consumer can reconcile
 *   total = subtotal + shipping + care − discount + (included ? 0 : tax)
 * without guessing the store's mode. False for an order carrying no TVA (nothing
 * to include — the identity holds either way).
 */
export function orderTaxIncludedInTotal(order: OrderTaxSnapshot): boolean {
  const effective = order.tax_manual_cents ?? order.tax_cents;
  return effective > 0 && preTaxBaseCents(order) === order.total_cents;
}

/**
 * The ORDER's effective TVA mode for a post-sale re-tax (edit-items: a changed
 * quantity, an added line, the ht add-on-top decision):
 *   - it carries TVA → "ht" when that TVA sits on top of the total, else "ttc"
 *     (its own arithmetic — see orderChargesTaxOnTop);
 *   - it carries none and every line was snapshotted with NO rate (place-order /
 *     the line builder write a NULL `tax_rate_bps` while TVA is off) → it was
 *     sold tax-free and stays "disabled": enabling TVA later never taxes it;
 *   - otherwise (0 %-rated lines, no signal) → the live mode.
 */
export function orderTaxMode(
  order: OrderTaxSnapshot,
  lines: ReadonlyArray<{ tax_rate_bps: number | null }>,
  liveMode: TaxMode,
): TaxMode {
  const effective = order.tax_manual_cents ?? order.tax_cents;
  if (effective > 0) return orderChargesTaxOnTop(order, liveMode) ? "ht" : "ttc";
  if (lines.length > 0 && lines.every((l) => l.tax_rate_bps == null)) return "disabled";
  return liveMode;
}

/** Why an order's TOTAL may no longer move (null = it still may). */
export type OrderTotalLock = "settled" | "gateway_pending" | null;

/**
 * The single rule for "may this order's total_cents still change?" — shared by
 * edit-items (a line edit) and set-invoice-tax (a TVA charged on top):
 *   - "settled": `paid_at` is set — the total is the CAPTURED amount (refunds
 *     are capped on it; the app has no partial-capture / balance-due model);
 *   - "gateway_pending": a pending online order with a gateway session — the
 *     customer may be paying the old amount right now, and the capture would
 *     then mismatch the new total and be refused (stuck order).
 * Each writer words its own refusal; a total-NEUTRAL change stays allowed.
 */
export function orderTotalLock(order: {
  status: string;
  paid_at: Date | null;
  payment_method: string | null;
  payment_reference: string | null;
}): OrderTotalLock {
  if (order.paid_at) return "settled";
  if (order.status === "pending" && isOnlineMethod(order.payment_method) && order.payment_reference) {
    return "gateway_pending";
  }
  return null;
}
