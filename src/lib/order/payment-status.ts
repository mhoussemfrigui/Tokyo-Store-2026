/**
 * Manual payment STATE — the operator-facing « payée / partiellement payée / non
 * payée » of an order, derived from `paid_at` + `amount_paid_cents` (migration
 * 0199). PURE (no server-only, no DB) so the admin control (client) and the
 * action/workflow (server) share ONE derivation.
 *
 * `paid_at` stays the authoritative FULLY-PAID signal (revenue keys off it).
 * `amount_paid_cents` is supplementary: the amount received when a payment is
 * PARTIAL (a deposit / installment), with `paid_at` left null until it's full.
 */

export type PaymentState = "unpaid" | "partial" | "paid";

export const PAYMENT_STATE_LABELS: Record<PaymentState, string> = {
  unpaid: "Non payée",
  partial: "Partiellement payée",
  paid: "Payée",
};

/**
 * The order's current payment state. `paid_at` set ⇒ fully paid; else a positive
 * `amount_paid_cents` ⇒ partial; otherwise unpaid.
 */
export function paymentStateOf(order: {
  paid_at: Date | string | null;
  amount_paid_cents: number | null;
}): PaymentState {
  if (order.paid_at != null) return "paid";
  if ((order.amount_paid_cents ?? 0) > 0) return "partial";
  return "unpaid";
}

/** The amount considered received: the full total once paid, else the partial, else 0. */
export function amountReceivedCents(order: {
  paid_at: Date | string | null;
  amount_paid_cents: number | null;
  total_cents: number;
}): number {
  if (order.paid_at != null) return order.total_cents;
  return Math.max(0, order.amount_paid_cents ?? 0);
}
