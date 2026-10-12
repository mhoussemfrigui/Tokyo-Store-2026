/**
 * Pure unit tests for the return↔refund advisory (L12). NO database.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/return-refund-advisory.test.ts
 */
import { deriveReturnRefundAdvisory } from "@/lib/order/return-refund-advisory";

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

console.log("return-refund-advisory:");

const level = (a: ReturnType<typeof deriveReturnRefundAdvisory>) => (a ? a.level : null);

// received goods, no refund → WARN
eq(
  "received return, €0 refunded → warn",
  level(deriveReturnRefundAdvisory({ receivedReturnCount: 1, pendingReturnCount: 0, refundedCents: 0 })),
  "warn",
);
// received goods AND refunded → consistent, no advisory
eq(
  "received return + refunded → null",
  deriveReturnRefundAdvisory({ receivedReturnCount: 1, pendingReturnCount: 0, refundedCents: 50_000 }),
  null,
);
// refund without any return → INFO
eq(
  "refund, no returns → info",
  level(deriveReturnRefundAdvisory({ receivedReturnCount: 0, pendingReturnCount: 0, refundedCents: 50_000 })),
  "info",
);
// pending return, nothing refunded → INFO (reminder)
eq(
  "pending return, no refund → info",
  level(deriveReturnRefundAdvisory({ receivedReturnCount: 0, pendingReturnCount: 1, refundedCents: 0 })),
  "info",
);
// pending return AND already refunded → consistent enough, no advisory
eq(
  "pending return + refunded → null",
  deriveReturnRefundAdvisory({ receivedReturnCount: 0, pendingReturnCount: 1, refundedCents: 10_000 }),
  null,
);
// nothing at all → null
eq(
  "no returns, no refund → null",
  deriveReturnRefundAdvisory({ receivedReturnCount: 0, pendingReturnCount: 0, refundedCents: 0 }),
  null,
);
// received takes precedence over a pending one when unrefunded → warn
eq(
  "received+pending, €0 → warn (received wins)",
  level(deriveReturnRefundAdvisory({ receivedReturnCount: 1, pendingReturnCount: 2, refundedCents: 0 })),
  "warn",
);

// A net-NEGATIVE refunded total (from a correction row) is clamped to 0, so a
// received-but-unrefunded return still warns (the negative must not read as
// "refunded > 0" and suppress the advisory).
eq(
  "received, net-negative refunded → clamped, still warns",
  level(deriveReturnRefundAdvisory({ receivedReturnCount: 1, pendingReturnCount: 0, refundedCents: -5_000 })),
  "warn",
);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
