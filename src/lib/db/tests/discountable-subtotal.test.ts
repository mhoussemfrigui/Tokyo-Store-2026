/**
 * Pure unit tests for the coupon discountable-subtotal helper — NO database.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/discountable-subtotal.test.ts
 */
import { discountableSubtotalCents } from "@/lib/promotions/discountable-subtotal";

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

console.log("discountableSubtotalCents:");

// All lines at base price (nothing on sale) → full subtotal.
eq(
  "no sale → full subtotal",
  discountableSubtotalCents([
    { unitCents: 1000, baseCents: 1000, quantity: 2 },
    { unitCents: 500, baseCents: 500, quantity: 1 },
  ]),
  2500,
);

// One line on sale (unit < base) → excluded from the base.
eq(
  "on-sale line excluded",
  discountableSubtotalCents([
    { unitCents: 1000, baseCents: 1000, quantity: 2 }, // 2000 counted
    { unitCents: 800, baseCents: 1000, quantity: 1 }, // discounted → 0
  ]),
  2000,
);

// All lines on sale → 0 discountable base.
eq(
  "all on sale → 0",
  discountableSubtotalCents([
    { unitCents: 800, baseCents: 1000, quantity: 1 },
    { unitCents: 450, baseCents: 500, quantity: 3 },
  ]),
  0,
);

// Empty cart → 0.
eq("empty → 0", discountableSubtotalCents([]), 0);

// unit == base (boundary) is NOT discounted → included.
eq("unit==base included", discountableSubtotalCents([{ unitCents: 1000, baseCents: 1000, quantity: 1 }]), 1000);

// Non-finite base → treated as not-discounted (counts), uses unit as base.
eq(
  "missing base counts the line",
  discountableSubtotalCents([{ unitCents: 1000, baseCents: NaN, quantity: 2 }]),
  2000,
);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
