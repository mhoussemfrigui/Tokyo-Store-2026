/**
 * Per-product purchase-quantity limits (PrestaShop minimal_quantity / WooCommerce
 * sold-individually). Pure (no DB / no server-only) so the cart, place-order and
 * admin all share one rule and it's unit-testable.
 *
 * A limit only "applies" when meaningful: a min of ≤1 is the implicit default
 * (no minimum), and a max of <1 is ignored. `max = 1` ⇒ "sold individually".
 */
export type PurchaseLimits = { min?: number | null; max?: number | null };

/** Normalize raw column values to the effective bounds (null = unbounded). */
export function effectivePurchaseLimits(limits: PurchaseLimits): { min: number | null; max: number | null } {
  const min = limits.min != null && Number.isFinite(limits.min) && limits.min > 1 ? Math.trunc(limits.min) : null;
  const max = limits.max != null && Number.isFinite(limits.max) && limits.max >= 1 ? Math.trunc(limits.max) : null;
  return { min, max };
}

/** The violation a quantity commits against the limits, or null when valid. */
export function purchaseQtyViolation(
  qty: number,
  limits: PurchaseLimits,
): "below_min" | "above_max" | null {
  const { min, max } = effectivePurchaseLimits(limits);
  if (max != null && qty > max) return "above_max";
  if (min != null && qty < min) return "below_min";
  return null;
}

/** Clamp a quantity into the [min, max] window (used for forgiving UI clamps).
 *  Apply the min floor BEFORE the max ceiling so that a contradictory config
 *  (min > max, e.g. a mis-entered "min 5 / max 2") resolves to the max, never
 *  above it — matching `purchaseQtyViolation`, which reports `above_max` first
 *  and would otherwise reject the very value this clamp produced. */
export function clampPurchaseQty(qty: number, limits: PurchaseLimits): number {
  const { min, max } = effectivePurchaseLimits(limits);
  let q = qty;
  if (min != null && q < min) q = min;
  if (max != null && q > max) q = max;
  return q;
}

/** One order line for the per-product limit roll-up (a variant = its own line). */
export type PurchaseLimitLine = {
  productId: string;
  quantity: number;
  /** Product display name — echoed back on a violation for the error message. */
  name: string;
} & PurchaseLimits;

/** A product whose ORDER-aggregated quantity breaks its purchase limit. */
export type PurchaseLimitViolation = {
  productId: string;
  name: string;
  violation: "below_min" | "above_max";
  /** The breached bound (the max for above_max, the min for below_min). */
  limit: number;
};

/**
 * The AUTHORITATIVE per-order purchase-limit gate: aggregate each line's quantity
 * BY PRODUCT (summing across a product's sibling variant lines) and report every
 * product whose total violates its min/max. This is what stops a buyer beating a
 * "max N per order" cap by spreading N across variants. Returns [] when all pass;
 * violations keep the products' first-seen (insertion) order so a caller throwing
 * on the first is deterministic. Pure — place-order maps its snapshots through it.
 */
export function aggregatePurchaseLimitViolations(
  lines: readonly PurchaseLimitLine[],
): PurchaseLimitViolation[] {
  const byProduct = new Map<string, { qty: number; name: string; min?: number | null; max?: number | null }>();
  for (const l of lines) {
    const cur = byProduct.get(l.productId);
    if (cur) cur.qty += l.quantity;
    else byProduct.set(l.productId, { qty: l.quantity, name: l.name, min: l.min, max: l.max });
  }
  const out: PurchaseLimitViolation[] = [];
  for (const [productId, p] of byProduct) {
    const v = purchaseQtyViolation(p.qty, { min: p.min, max: p.max });
    if (v === "above_max") out.push({ productId, name: p.name, violation: v, limit: p.max ?? 0 });
    else if (v === "below_min") out.push({ productId, name: p.name, violation: v, limit: p.min ?? 0 });
  }
  return out;
}
