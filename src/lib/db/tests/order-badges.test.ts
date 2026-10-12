/**
 * Pure unit tests for the derived order badges (L1) — fulfilment + refund.
 * NO database.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/order-badges.test.ts
 */
import { deriveFulfilmentBadge, deriveRefundBadge } from "@/lib/order/badges";

let passed = 0;
let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = got === want;
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}

console.log("order-badges:");

// ── deriveFulfilmentBadge(shippableOrdered, shipped)
eq("nothing shipped → none", deriveFulfilmentBadge(5, 0), "none");
eq("no shippable goods → none", deriveFulfilmentBadge(0, 0), "none");
eq("some shipped, more to go → partial", deriveFulfilmentBadge(5, 2), "partial");
eq("all shipped → full", deriveFulfilmentBadge(5, 5), "full");
eq("over-shipped clamps to full", deriveFulfilmentBadge(5, 7), "full");
eq("1 of 1 → full", deriveFulfilmentBadge(1, 1), "full");
eq("shipped on a 0-shippable order (data drift) → none", deriveFulfilmentBadge(0, 3), "none");

// ── deriveRefundBadge(total, refunded)
eq("no refund → none", deriveRefundBadge(100_000, 0), "none");
eq("partial refund → partial", deriveRefundBadge(100_000, 40_000), "partial");
eq("full refund → full", deriveRefundBadge(100_000, 100_000), "full");
eq("over-refund (rounding / multi) → full", deriveRefundBadge(100_000, 120_000), "full");
eq("refund on a 0-total order → partial (can't be 'full' vs 0)", deriveRefundBadge(0, 5_000), "partial");
eq("negative refund total (reversal net) → none", deriveRefundBadge(100_000, -1_000), "none");
// Boundary: one millime short of full must stay "partial" (guards a `>`/`>=` flip).
eq("refunded = total - 1 → partial", deriveRefundBadge(100_000, 99_999), "partial");
eq("minimal positive total, exact full → full", deriveRefundBadge(1, 1), "full");
eq("0 total, 0 refund → none", deriveRefundBadge(0, 0), "none");

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
