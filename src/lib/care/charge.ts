/**
 * Tokyo Care charge + eligibility — the PURE half (no DB, no "server-only"), so
 * the storefront offer, the PDP, and the order charge all agree byte-for-byte and
 * it is unit-testable. Money is integer MILLIMES; rates are basis points.
 *
 * Resolution (product WINS over category scope):
 *   offered = (category-scope matches ∪ product-care INCLUDE) − product-care EXCLUDE
 * A product-care INCLUDE is a deliberate per-product attachment, so it BYPASSES
 * the plan's generic eligibility (warranty / min price / condition); a scope-only
 * offer must pass eligibility. The price is the override (if the include set one)
 * else the plan's own flat / percent price, floored by `min_charge_cents` and
 * rounded UP to `price_round_to_cents`.
 */
import type { CarePlanRow } from "@/modules/catalog/care/schema";
import type { ProductCareRow } from "@/associations/product-care";

export type ProductCondition = "new" | "used" | "refurbished";

/** Per-product inputs for resolving a plan's eligibility + price. */
export type CareProductCtx = {
  /** The line's effective unit price (millimes) — percent plans apply to this. */
  productPriceCents: number;
  /** Resolved warranty months for the product (cascade snapshot); null/0 = none. */
  warrantyMonths: number | null;
  /** Product condition (état). */
  condition: ProductCondition;
};

const PRICING = {
  min: (cents: number, floor: number) => (floor > 0 && cents < floor ? floor : cents),
  roundUp: (cents: number, step: number) => (step > 0 ? Math.ceil(cents / step) * step : cents),
};

/**
 * Does a plan's GENERIC eligibility accept this product? (warranty requirement,
 * minimum product price, allowed conditions). An empty `applicable_conditions`
 * means "all conditions". Pure.
 */
export function isCarePlanEligible(
  plan: Pick<CarePlanRow, "require_warranty" | "min_product_price_cents" | "applicable_conditions">,
  ctx: CareProductCtx,
): boolean {
  if (plan.require_warranty && !(ctx.warrantyMonths != null && ctx.warrantyMonths > 0)) return false;
  if (plan.min_product_price_cents > 0 && ctx.productPriceCents < plan.min_product_price_cents) return false;
  const conds = Array.isArray(plan.applicable_conditions)
    ? (plan.applicable_conditions as ProductCondition[])
    : [];
  if (conds.length > 0 && !conds.includes(ctx.condition)) return false;
  return true;
}

/**
 * The PER-UNIT care price (millimes) for a plan on a product, or null when there
 * is nothing to charge. `overridePriceCents` (a product-care INCLUDE override)
 * replaces the computed price as-is (operator's exact figure); otherwise the plan
 * price is flat or `percent × productPrice`, floored by `min_charge_cents` and
 * rounded up to `price_round_to_cents`. Pure.
 */
export function computeCareUnitCents(
  plan: Pick<
    CarePlanRow,
    "pricing_mode" | "price_cents" | "price_bps" | "price_round_to_cents" | "min_charge_cents"
  >,
  productPriceCents: number,
  overridePriceCents: number | null | undefined,
): number | null {
  if (overridePriceCents != null && overridePriceCents >= 0) {
    return overridePriceCents > 0 ? overridePriceCents : null;
  }
  let cents =
    plan.pricing_mode === "flat"
      ? plan.price_cents
      : Math.round((Math.max(0, productPriceCents) * plan.price_bps) / 10000);
  cents = PRICING.min(cents, plan.min_charge_cents);
  cents = PRICING.roundUp(cents, plan.price_round_to_cents);
  return cents > 0 ? cents : null;
}

export type OfferedCarePlan = { plan: CarePlanRow; unitCents: number };

/**
 * Resolve the Tokyo Care plans OFFERED on one product, with each one's per-unit
 * price — the single source of truth for the storefront offer AND the order
 * charge. `scopeOfferedPlanIds` is the category-scope match set (see
 * @/lib/care/scope); `productCareRows` the per-product include/exclude overrides.
 * Sorted by `display_priority` desc then name. Pure.
 */
export function resolveOfferedCarePlans(
  ctx: CareProductCtx,
  activePlans: CarePlanRow[],
  scopeOfferedPlanIds: ReadonlySet<string>,
  productCareRows: ProductCareRow[],
): OfferedCarePlan[] {
  const byPlan = new Map(productCareRows.map((r) => [r.care_plan_id, r]));
  const out: OfferedCarePlan[] = [];
  for (const plan of activePlans) {
    const pc = byPlan.get(plan.id);
    if (pc?.mode === "exclude") continue;
    const forced = pc?.mode === "include";
    if (!forced && !scopeOfferedPlanIds.has(plan.id)) continue;
    if (!forced && !isCarePlanEligible(plan, ctx)) continue;
    const unitCents = computeCareUnitCents(plan, ctx.productPriceCents, pc?.override_price_cents ?? null);
    if (unitCents == null) continue;
    out.push({ plan, unitCents });
  }
  out.sort((a, b) => b.plan.display_priority - a.plan.display_priority || a.plan.name.localeCompare(b.plan.name));
  return out;
}
