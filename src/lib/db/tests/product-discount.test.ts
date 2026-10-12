/**
 * Product-discount engine — the PURE math in src/lib/promotions/product-discount.ts
 * (computeProductDiscount + resolveProductDiscount) and the discountPercent badge
 * helper (src/lib/promotions/discount.ts). This engine drives the per-line price
 * on EVERY surface (cards, search, cart, order-line snapshot, PDP, checkout
 * charge) in lockstep, so a regression silently misprices everywhere. No DB. Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/product-discount.test.ts
 */
import {
  computeProductDiscount,
  resolveProductDiscount,
} from "@/lib/promotions/product-discount";
import { discountPercent } from "@/lib/promotions/discount";
import type { PromotionRow } from "@/modules/promotion/schema";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

/** Minimal promotion fixture — only the fields the pure engine reads. */
function promo(p: Partial<PromotionRow>): PromotionRow {
  return {
    discount_type: "percent",
    discount_value: 0,
    max_discount_cents: null,
    is_stackable: false,
    display_priority: 0,
    ...p,
  } as PromotionRow;
}

// ── computeProductDiscount ────────────────────────────────────────────────────
{
  const r = computeProductDiscount(100_000, promo({ discount_type: "percent", discount_value: 10 }));
  check("percent: 10% of 100000 → effective 90000", r.effectivePriceCents === 90_000 && r.discountCents === 10_000);
}
{
  const r = computeProductDiscount(100_000, promo({ discount_type: "fixed", discount_value: 15_000 }));
  check("fixed: 15000 off 100000 → effective 85000", r.effectivePriceCents === 85_000 && r.discountCents === 15_000);
}
{
  const r = computeProductDiscount(100_000, promo({ discount_type: "fixed", discount_value: 250_000 }));
  check("fixed bigger than price → floors at 0", r.effectivePriceCents === 0 && r.discountCents === 100_000);
}
{
  const r = computeProductDiscount(100_000, promo({ discount_type: "percent", discount_value: 150 }));
  check("percent > 100 → effective floors at 0", r.effectivePriceCents === 0);
}
{
  // 30% of 100000 = 30000, but capped at 20000.
  const r = computeProductDiscount(100_000, promo({ discount_type: "percent", discount_value: 30, max_discount_cents: 20_000 }));
  check("percent capped by max_discount_cents", r.discountCents === 20_000 && r.effectivePriceCents === 80_000);
}
{
  const r = computeProductDiscount(99_999, promo({ discount_type: "percent", discount_value: 10 }));
  check("percent rounds the discount (10% of 99999 → 10000)", r.discountCents === 10_000 && r.effectivePriceCents === 89_999);
}

// ── resolveProductDiscount ────────────────────────────────────────────────────
check("no promotions → null", resolveProductDiscount(100_000, []) === null);
{
  const r = resolveProductDiscount(100_000, [promo({ discount_type: "percent", discount_value: 10, is_stackable: false })]);
  check("single non-stackable → that discount", r?.effectivePriceCents === 90_000);
}
{
  // Two stackable percents compound: 100000 → 10% → 90000 → 5% → 85500.
  const r = resolveProductDiscount(100_000, [
    promo({ discount_type: "percent", discount_value: 10, is_stackable: true, display_priority: 2 }),
    promo({ discount_type: "percent", discount_value: 5, is_stackable: true, display_priority: 1 }),
  ]);
  check("two stackable percents compound → 85500", r?.effectivePriceCents === 85_500);
}
{
  // ODD input pins the PER-STEP rounding contract (each step rounds, then the
  // next step applies to the rounded remainder). 155 → round(15.5)=16 → 139 →
  // round(13.9)=14 → 125. A switch to compound-then-round would give
  // round(155*0.9*0.9)=126, so this case guards against that regression (the
  // clean-divisible 100000 case above cannot detect it).
  const r = resolveProductDiscount(155, [
    promo({ discount_type: "percent", discount_value: 10, is_stackable: true, display_priority: 2 }),
    promo({ discount_type: "percent", discount_value: 10, is_stackable: true, display_priority: 1 }),
  ]);
  check("two stacked 10% round per-step → 125 (compound would be 126)", r?.effectivePriceCents === 125);
}
{
  // Stacked = 85500; a non-stackable 30% (→70000) is the better deal → wins.
  const r = resolveProductDiscount(100_000, [
    promo({ discount_type: "percent", discount_value: 10, is_stackable: true, display_priority: 2 }),
    promo({ discount_type: "percent", discount_value: 5, is_stackable: true, display_priority: 1 }),
    promo({ discount_type: "percent", discount_value: 30, is_stackable: false, display_priority: 5 }),
  ]);
  check("non-stackable beats stacked when cheaper for the shopper", r?.effectivePriceCents === 70_000);
}
{
  // Headline badge = highest display_priority among the applied stackables.
  const r = resolveProductDiscount(100_000, [
    promo({ discount_type: "percent", discount_value: 5, is_stackable: true, display_priority: 9 }),
    promo({ discount_type: "percent", discount_value: 10, is_stackable: true, display_priority: 3 }),
  ]);
  check("headline promo = highest display_priority", r?.promotion.display_priority === 9);
}

// ── discountPercent (badge) ───────────────────────────────────────────────────
check("discountPercent 80000/100000 → 20", discountPercent(80_000, 100_000) === 20);
check("discountPercent equal → 0", discountPercent(100_000, 100_000) === 0);
check("discountPercent price>old → 0", discountPercent(120_000, 100_000) === 0);
check("discountPercent price 0 → 0 (guard, no div issues)", discountPercent(0, 100_000) === 0);
check("discountPercent rounds (67000/100000 → 33)", discountPercent(67_000, 100_000) === 33);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
