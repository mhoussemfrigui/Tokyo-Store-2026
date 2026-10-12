/**
 * Pure unit tests for per-product purchase-quantity limits — NO database.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/purchase-limits.test.ts
 */
import {
  aggregatePurchaseLimitViolations,
  clampPurchaseQty,
  effectivePurchaseLimits,
  purchaseQtyViolation,
} from "@/lib/cart/purchase-limits";

let passed = 0;
let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}

console.log("purchase-limits:");

// effectivePurchaseLimits — min<=1 and max<1 are "no limit".
eq("min 1 → no min", effectivePurchaseLimits({ min: 1, max: null }), { min: null, max: null });
eq("min 0/null → no min", effectivePurchaseLimits({ min: 0 }), { min: null, max: null });
eq("min 3 / max 5", effectivePurchaseLimits({ min: 3, max: 5 }), { min: 3, max: 5 });
eq("max 1 = sold individually", effectivePurchaseLimits({ max: 1 }), { min: null, max: 1 });

// purchaseQtyViolation
eq("no limits → valid", purchaseQtyViolation(50, {}), null);
eq("above max", purchaseQtyViolation(2, { max: 1 }), "above_max");
eq("at max → valid", purchaseQtyViolation(1, { max: 1 }), null);
eq("below min", purchaseQtyViolation(2, { min: 3 }), "below_min");
eq("at min → valid", purchaseQtyViolation(3, { min: 3 }), null);
eq("max checked before min", purchaseQtyViolation(10, { min: 3, max: 5 }), "above_max");

// clampPurchaseQty
eq("clamp down to max", clampPurchaseQty(9, { max: 2 }), 2);
eq("clamp up to min", clampPurchaseQty(1, { min: 3 }), 3);
eq("within window unchanged", clampPurchaseQty(4, { min: 3, max: 5 }), 4);
eq("no limits unchanged", clampPurchaseQty(7, {}), 7);
// Contradictory config (min > max): the max ceiling wins, never a value above it
// — matches purchaseQtyViolation reporting above_max first.
eq("clamp min>max resolves to max, not above", clampPurchaseQty(3, { min: 5, max: 2 }), 2);
eq("clamp min>max from below still caps at max", clampPurchaseQty(1, { min: 5, max: 2 }), 2);

// aggregatePurchaseLimitViolations — the per-ORDER-per-PRODUCT gate. This is the
// security-relevant part: a "max 1" cap can't be beaten by spreading qty across
// two variants of the SAME product (two lines, same productId, summed).
const L = (productId: string, quantity: number, lim: { min?: number | null; max?: number | null }) => ({
  productId,
  quantity,
  name: productId.toUpperCase(),
  ...lim,
});
eq("agg: empty → no violations", aggregatePurchaseLimitViolations([]), []);
eq(
  "agg: two variant lines of A (1+1) vs max 1 → above_max on the SUM (2)",
  aggregatePurchaseLimitViolations([L("a", 1, { max: 1 }), L("a", 1, { max: 1 })]),
  [{ productId: "a", name: "A", violation: "above_max", limit: 1 }],
);
eq(
  "agg: two products each within their own limits → none",
  aggregatePurchaseLimitViolations([L("a", 1, { max: 2 }), L("b", 3, { min: 2, max: 5 })]),
  [],
);
eq(
  "agg: A across 3 variants summing below its min → below_min",
  aggregatePurchaseLimitViolations([L("a", 1, { min: 5 }), L("a", 1, { min: 5 }), L("a", 1, { min: 5 })]),
  [{ productId: "a", name: "A", violation: "below_min", limit: 5 }],
);
eq(
  "agg: above_max reported (not below_min) when both could apply per product",
  aggregatePurchaseLimitViolations([L("a", 10, { min: 3, max: 5 })]),
  [{ productId: "a", name: "A", violation: "above_max", limit: 5 }],
);
eq(
  "agg: multiple products, only the violator reported, insertion order kept",
  aggregatePurchaseLimitViolations([L("a", 1, {}), L("b", 9, { max: 4 }), L("c", 1, { max: 2 })]),
  [{ productId: "b", name: "B", violation: "above_max", limit: 4 }],
);
eq(
  "agg: a no-limit product never violates regardless of qty",
  aggregatePurchaseLimitViolations([L("a", 99, {})]),
  [],
);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
