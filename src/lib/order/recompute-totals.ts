import "server-only";

// Import the PURE tax half (no DB / no settings resolver) so this money-math
// helper stays DB-free + unit-testable; the `@/lib/tax` barrel would drag in the
// settings-backed getTaxConfig() → DB client.
import { computeTaxCents } from "@/lib/tax/shared";

/**
 * Recompute an order's money totals from a post-edit line set — the SINGLE place
 * the totals semantics live for operator order-line edits. Byte-for-byte the
 * place-order math (place-order.ts: subtotal → per-line tax sum + shipping tax →
 * ht-only add → clamp): so an edited order's arithmetic stays identical to a
 * freshly-placed one.
 *
 * Discount policy (frozen + re-clamped): the coupon/member `discountCents` is
 * NOT re-derived (no coupon/member re-evaluation on a line tweak — that would
 * re-open eligibility/caps and surprise the operator). It is only clamped DOWN
 * so it can never exceed the new (possibly smaller) subtotal — mirroring
 * place-order's `Math.min(subtotal, …)` — keeping `total_cents` non-negative and
 * arithmetically consistent.
 */
export function recomputeOrderTotals(input: {
  lines: Array<{ unitPriceCents: number; quantity: number; taxCents: number }>;
  shippingCents: number;
  discountCents: number;
  taxMode: "ht" | "ttc" | "disabled";
  taxDefaultRateBps: number;
  taxOnShipping: boolean;
  /**
   * The shipping-tax term to KEEP (an existing order's own, e.g. `tax_cents −
   * Σ original line tax`) instead of re-deriving it from the live rate +
   * on_shipping flag — shipping never changes in a post-sale edit, and a later
   * config change must not re-tax it. Omitted → computed from the flag + rate.
   */
  shippingTaxCents?: number;
  /**
   * Tokyo Care charge to PRESERVE across the edit (the order-line editor never
   * touches protection — care rides on the goods line unchanged). `careCents` is
   * the ex-TVA add-on added to the base; `careTaxCents` its TVA, folded into the
   * tax total (so an `ht` order keeps care tax in `total_cents`). Omitted → 0.
   */
  careCents?: number;
  careTaxCents?: number;
}): {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  clampedDiscountCents: number;
} {
  const subtotalCents = input.lines.reduce((a, l) => a + l.unitPriceCents * l.quantity, 0);
  const itemsTaxCents = input.lines.reduce((a, l) => a + l.taxCents, 0);
  const shippingTaxCents =
    input.shippingTaxCents != null
      ? Math.max(0, input.shippingTaxCents)
      : input.taxOnShipping
        ? computeTaxCents(input.shippingCents, input.taxDefaultRateBps, input.taxMode)
        : 0;
  const careCents = Math.max(0, input.careCents ?? 0);
  const careTaxCents = Math.max(0, input.careTaxCents ?? 0);
  const orderTaxCents = itemsTaxCents + shippingTaxCents + careTaxCents;

  // Re-clamp the frozen discount to the new subtotal (mirrors place-order).
  const clampedDiscountCents = Math.min(subtotalCents, Math.max(0, input.discountCents));

  const totalTaxAddCents = input.taxMode === "ht" ? orderTaxCents : 0;
  // Care is a preserved charge (added, never discounted), exactly like place-order.
  const totalCents = Math.max(
    0,
    subtotalCents + input.shippingCents + careCents + totalTaxAddCents - clampedDiscountCents,
  );
  return { subtotalCents, taxCents: orderTaxCents, totalCents, clampedDiscountCents };
}
