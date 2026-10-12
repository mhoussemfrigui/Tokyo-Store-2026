/**
 * decideConfirmation — the PURE post-verify settlement decision used by
 * confirmPayment. Locks the money-critical branching: only `paid` + an EXACT
 * amount match settles; a non-paid status is a no-op (echoed); a null/wrong
 * amount FAILS CLOSED as a mismatch (never settles). No DB / network.
 *
 * NOT covered here (DB-only, exercised by the gateway integration tests): the
 * already-settled short-circuit (the workflow returns before the gateway call),
 * and the claim/release/transition idempotency block.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/confirm-payment-decision.test.ts
 */
import { decideConfirmation } from "@/lib/payments/verify-mapping";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

const EXPECTED = 50_000; // millimes

function main() {
  // paid + exact match → settle.
  check(
    "paid + matching amount → settle",
    decideConfirmation({ status: "paid", amountMinor: EXPECTED }, EXPECTED).action === "settle",
  );

  // paid + null amount → amount_mismatch (FAIL CLOSED — the core guard).
  check(
    "paid + null amount → amount_mismatch (fail-closed)",
    decideConfirmation({ status: "paid", amountMinor: null }, EXPECTED).action === "amount_mismatch",
  );

  // paid + wrong amount → amount_mismatch.
  check(
    "paid + underpaid → amount_mismatch",
    decideConfirmation({ status: "paid", amountMinor: 49_999 }, EXPECTED).action === "amount_mismatch",
  );
  check(
    "paid + overpaid → amount_mismatch",
    decideConfirmation({ status: "paid", amountMinor: 50_001 }, EXPECTED).action === "amount_mismatch",
  );

  // non-paid statuses → noop_status (status echoed for the caller to surface).
  for (const status of ["pending", "failed", "cancelled"] as const) {
    const d = decideConfirmation({ status, amountMinor: EXPECTED }, EXPECTED);
    check(
      `${status} → noop_status (echoed)`,
      d.action === "noop_status" && d.status === status,
    );
  }

  // A non-paid status is a no-op REGARDLESS of amount (amount is only checked
  // once paid) — guards against ever settling a failed-but-amount-matching reply.
  check(
    "failed + matching amount → still noop_status (never settles)",
    decideConfirmation({ status: "failed", amountMinor: EXPECTED }, EXPECTED).action === "noop_status",
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
