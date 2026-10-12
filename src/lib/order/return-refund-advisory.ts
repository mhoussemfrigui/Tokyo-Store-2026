/**
 * PURE return↔refund advisory (L12) — NO "server-only", NO DB, so it can be
 * unit-tested directly and used in both RSC and client components.
 *
 * Returns (retours) and refunds (order_refunds) are DELIBERATELY decoupled — a
 * return records the physical goods movement, a refund records money, and one
 * does not auto-trigger the other (see order/returns.schema.ts). That decoupling
 * is correct but easy to forget, so this surfaces an operator nudge on the order
 * detail page when the two sides are out of step. Advisory only — it never
 * blocks or auto-acts.
 */

export type ReturnRefundAdvisory = { level: "warn" | "info"; message: string } | null;

/**
 * Derive the advisory from the return counts + the cumulative refunded amount.
 *   - received goods but €0 refunded → WARN (a refund is probably owed);
 *   - money refunded with no return on file → INFO (goodwill / pre-receipt);
 *   - a return awaiting receipt, nothing refunded → INFO (gentle reminder).
 * When the two sides are consistent (both done, or nothing to do) → null.
 */
export function deriveReturnRefundAdvisory(input: {
  receivedReturnCount: number;
  pendingReturnCount: number;
  refundedCents: number;
}): ReturnRefundAdvisory {
  const received = Math.max(0, input.receivedReturnCount);
  const pending = Math.max(0, input.pendingReturnCount);
  // Clamp like the counts above — a negative-correction refund row could sum to
  // a net-negative total, which must not flip the `refunded > 0` advisory logic.
  const refunded = Math.max(0, input.refundedCents);

  if (received > 0 && refunded <= 0) {
    return {
      level: "warn",
      message:
        "Un ou plusieurs retours ont été reçus, mais aucun remboursement n'a encore été émis. " +
        "Retours et remboursements sont indépendants — émettez un remboursement si le client doit être crédité.",
    };
  }
  if (refunded > 0 && received === 0 && pending === 0) {
    return {
      level: "info",
      message:
        "Un remboursement a été émis sans retour enregistré (remboursement commercial, ou avant réception des articles).",
    };
  }
  if (pending > 0 && received === 0 && refunded <= 0) {
    return {
      level: "info",
      message:
        "Un retour est en attente de réception. Le remboursement éventuel reste à émettre séparément une fois les articles reçus.",
    };
  }
  return null;
}
