/**
 * PURE derived order badges (L1) — fulfilment + refund display state. NO
 * "server-only", NO DB, so it can be unit-tested directly and used in both RSC
 * pages and client components. Mirrors the convention of `src/lib/order/status.ts`.
 *
 * These are ADDITIVE signals that `order.status` doesn't convey on its own:
 *   - "expédition partielle" — some physical units shipped, not all (mid-BL);
 *   - "remboursement partiel" / "remboursée" — a refund (partial or full) was
 *     issued, which a non-`refunded` status hides.
 *
 * Fulfilment is computed against the SHIPPABLE ordered quantity (a line whose
 * live product row is gone is excluded) — see
 * `orderService.shippableOrderedByOrder`.
 */

export type FulfilmentBadge = "none" | "partial" | "full";
export type RefundBadge = "none" | "partial" | "full";

/**
 * Fulfilment state from the shippable-ordered vs shipped unit totals.
 *   - no shippable goods, or nothing shipped yet → "none";
 *   - shipped ≥ shippable → "full";
 *   - 0 < shipped < shippable → "partial".
 */
export function deriveFulfilmentBadge(
  shippableOrderedQty: number,
  shippedQty: number,
): FulfilmentBadge {
  if (shippableOrderedQty <= 0 || shippedQty <= 0) return "none";
  if (shippedQty >= shippableOrderedQty) return "full";
  return "partial";
}

/**
 * Refund state from the order total vs the cumulative refunded amount (millimes).
 *   - nothing refunded → "none";
 *   - refunded ≥ total → "full";
 *   - 0 < refunded < total → "partial".
 */
export function deriveRefundBadge(orderTotalCents: number, refundedCents: number): RefundBadge {
  if (refundedCents <= 0) return "none";
  if (orderTotalCents > 0 && refundedCents >= orderTotalCents) return "full";
  return "partial";
}

// Only the "partial" fulfilment state renders a chip — a "full" shipment is
// already conveyed by order.status (shipped/delivered), so the map is
// deliberately partial-only (no dead "full" label/color).
export const FULFILMENT_BADGE_LABELS: Record<"partial", string> = {
  partial: "Expédition partielle",
};

/** Both refund states render (partial + full), so this map carries both. */
export const REFUND_BADGE_LABELS: Record<Exclude<RefundBadge, "none">, string> = {
  partial: "Remboursement partiel",
  full: "Remboursée",
};

/** Tailwind chip classes per state (amber = attention, neutral = done) — STATUS TONES. */
export const FULFILMENT_BADGE_COLORS: Record<"partial", string> = {
  partial: "bg-[#fff4e0] text-[#b45309]",
};

export const REFUND_BADGE_COLORS: Record<Exclude<RefundBadge, "none">, string> = {
  partial: "bg-[#fff4e0] text-[#b45309]",
  full: "bg-[#f6f2ed] text-[#5b5d62]",
};
