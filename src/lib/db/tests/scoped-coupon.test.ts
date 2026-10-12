/**
 * Pure unit tests for the SCOPED-coupon base helper (L7) — NO database.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/scoped-coupon.test.ts
 */
import { scopedCouponBaseCents, type CouponCartLine } from "@/lib/promotions/scoped-coupon";

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

console.log("scoped-coupon:");

const lines: CouponCartLine[] = [
  { productId: "a", lineCents: 10_000, baseLineCents: 10_000 }, // not on sale
  { productId: "b", lineCents: 8_000, baseLineCents: 10_000 }, // on sale (auto-promo)
  { productId: "c", lineCents: 5_000, baseLineCents: 5_000 }, // not on sale
];

// Only matching lines count.
eq(
  "sum of matched lines {a,c}",
  scopedCouponBaseCents(lines, new Set(["a", "c"]), false),
  15_000,
);
eq(
  "single match {b}",
  scopedCouponBaseCents(lines, new Set(["b"]), false),
  8_000,
);
eq("no match → 0", scopedCouponBaseCents(lines, new Set(["zzz"]), false), 0);
eq("empty match set → 0", scopedCouponBaseCents(lines, new Set<string>(), false), 0);

// excludeDiscounted skips lines already cut by an auto-promo (lineCents < base).
eq(
  "exclude-discounted skips the on-sale {b}",
  scopedCouponBaseCents(lines, new Set(["a", "b", "c"]), true),
  15_000, // a + c only; b is on sale
);
eq(
  "exclude-discounted: all matched but only b on sale → a+c",
  scopedCouponBaseCents(lines, new Set(["a", "b", "c"]), false),
  23_000, // includes b when not excluding
);
eq(
  "exclude-discounted with ONLY the on-sale line matched → 0",
  scopedCouponBaseCents(lines, new Set(["b"]), true),
  0,
);

// A match set with an id not in the cart is harmlessly ignored.
eq(
  "extra unknown id in match set is ignored",
  scopedCouponBaseCents(lines, new Set(["a", "ghost"]), false),
  10_000,
);

// Empty cart → 0 regardless of match set.
eq("empty cart → 0", scopedCouponBaseCents([], new Set(["a"]), false), 0);

// DUPLICATE productId across lines — the real multi-variant cart shape (place-order
// passes one line per variant, so the same product appears N times). Both lines
// must be summed (the helper iterates lines, not products).
const dupLines: CouponCartLine[] = [
  { productId: "a", lineCents: 6_000, baseLineCents: 6_000 }, // variant 1
  { productId: "a", lineCents: 4_000, baseLineCents: 5_000 }, // variant 2, on sale
];
eq(
  "duplicate productId across lines → both summed",
  scopedCouponBaseCents(dupLines, new Set(["a"]), false),
  10_000,
);
eq(
  "duplicate productId + exclude-discounted → only the full-price line",
  scopedCouponBaseCents(dupLines, new Set(["a"]), true),
  6_000, // variant 2 is on sale (4000 < 5000) → skipped
);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
