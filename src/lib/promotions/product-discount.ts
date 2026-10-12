/**
 * Pure product-discount math engine.
 *
 * Extracted from `@/modules/promotion/queries` (which is `server-only` + imports
 * `db`) so the core pricing logic can be unit-tested WITHOUT dragging in the DB
 * chain. `@/modules/promotion/queries` re-exports these (and so does the module
 * barrel), so existing callers keep importing from `@/modules/promotion`.
 *
 * No `db`, no `server-only` — only the `PromotionRow` shape (a DB-free Drizzle
 * `$inferSelect` type). Safe to import from a pure test or a client-safe path.
 */
import type { PromotionRow } from "@/modules/promotion/schema";

export type ProductDiscount = {
  promotion: PromotionRow;
  /** Effective unit price in millimes AFTER the discount. */
  effectivePriceCents: number;
  /** Millimes saved per unit. */
  discountCents: number;
};

/**
 * Apply ONE promotion to a unit price (all amounts integer millimes):
 *   - percent: effective = unit * (1 - value/100), discount rounded to nearest
 *     minor unit, optionally capped by `max_discount_cents` (per unit)
 *   - fixed:   effective = max(0, unit - value)
 * The effective price is floored at 0 — a promotion never negative-outs a price.
 */
export function computeProductDiscount(
  unitPriceCents: number,
  promotion: PromotionRow,
): ProductDiscount {
  let discountCents = 0;
  if (promotion.discount_type === "percent") {
    discountCents = Math.round((unitPriceCents * promotion.discount_value) / 100);
    // F1: optional per-promo cap on a percent discount (millimes, per unit).
    if (promotion.max_discount_cents != null) {
      discountCents = Math.min(discountCents, promotion.max_discount_cents);
    }
  } else {
    discountCents = promotion.discount_value;
  }
  // Floor at 0 — we never let a promotion negative-out a product.
  const effective = Math.max(0, unitPriceCents - discountCents);
  return {
    promotion,
    effectivePriceCents: effective,
    discountCents: unitPriceCents - effective,
  };
}

/**
 * Pick the single best (highest display_priority, then percent-equivalent)
 * non-stackable promotion. When all matches are stackable, combine them.
 *
 * Stackable combination order: percent first (compounding), then fixed
 * (a flat number off the discounted total). This mirrors what most
 * e-commerce platforms ship by default. `promotions` MUST be pre-sorted by
 * `display_priority` DESC (head wins) — the service layer guarantees this.
 */
export function resolveProductDiscount(
  unitPriceCents: number,
  promotions: PromotionRow[],
): ProductDiscount | null {
  if (promotions.length === 0) return null;

  // Split: stackable rows we combine, non-stackable rows we pick from.
  const stackable = promotions.filter((p) => p.is_stackable);
  const nonStackable = promotions.filter((p) => !p.is_stackable);

  if (stackable.length === 0) {
    // Single best non-stackable. Already pre-sorted by service layer
    // (display_priority DESC), so head wins.
    return computeProductDiscount(unitPriceCents, nonStackable[0]);
  }

  // Apply stackable in priority order (already sorted). Then if there's
  // a non-stackable winner, compare to the stacked total and pick the
  // better deal for the shopper.
  let running = unitPriceCents;
  let winningPromo: PromotionRow = stackable[0];
  for (const p of stackable) {
    const step = computeProductDiscount(running, p);
    running = step.effectivePriceCents;
    if (p.display_priority >= winningPromo.display_priority) {
      // Keep the highest-priority promotion as the "headline" badge.
      winningPromo = p;
    }
  }

  if (nonStackable.length > 0) {
    const nonStackBest = computeProductDiscount(unitPriceCents, nonStackable[0]);
    if (nonStackBest.effectivePriceCents < running) {
      return nonStackBest;
    }
  }

  return {
    promotion: winningPromo,
    effectivePriceCents: running,
    discountCents: unitPriceCents - running,
  };
}
