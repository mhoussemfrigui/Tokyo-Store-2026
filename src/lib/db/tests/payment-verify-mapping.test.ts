/**
 * Gateway verify-response → VerifyResult mapping — the PURE money-critical
 * parsing in src/lib/payments/verify-mapping.ts (Flouci / ClicToPay).
 * A wrong status or a null amount silently strands a paid order `pending`
 * (confirmPayment fails closed on a null amount), so this locks the parsing —
 * especially numeric-STRING amounts, which gateways commonly serialise. No DB.
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/payment-verify-mapping.test.ts
 */
import {
  coerceAmountMinor,
  mapFlouciVerify,
  mapClictopayVerify,
} from "@/lib/payments/verify-mapping";

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
const OK = { ok: true, status: 200 };
const BAD = { ok: false, status: 502 };

// ── coerceAmountMinor ─────────────────────────────────────────────────────────
check("coerce number", coerceAmountMinor(12345) === 12345);
check("coerce numeric string", coerceAmountMinor("12345") === 12345);
check("coerce rounds float", coerceAmountMinor(12345.6) === 12346);
check("coerce blank/null/garbage → null", coerceAmountMinor("", null, undefined, "abc") === null);
check("coerce first valid candidate wins", coerceAmountMinor(null, "990", 5) === 990);

// ── Flouci ────────────────────────────────────────────────────────────────────
{
  const r = mapFlouciVerify({ success: true, result: { status: "SUCCESS", amount: 50000 } }, OK);
  check("flouci SUCCESS+success+amount → paid 50000", r.ok && r.status === "paid" && r.amountMinor === 50000);
}
{
  // success flag absent on the verify response → still settle (relaxed; amount guard protects).
  const r = mapFlouciVerify({ result: { status: "SUCCESS", amount: "50000" } }, OK);
  check("flouci SUCCESS without success-flag (string amount) → paid 50000", r.ok && r.status === "paid" && r.amountMinor === 50000);
}
{
  const r = mapFlouciVerify({ success: false, result: { status: "SUCCESS", amount: 50000 } }, OK);
  check("flouci SUCCESS but success:false → pending (not settled)", r.ok && r.status === "pending");
}
check("flouci EXPIRED → failed", (() => { const r = mapFlouciVerify({ result: { status: "EXPIRED" } }, OK); return r.ok && r.status === "failed"; })());
check("flouci SYSTEM_FAILURE → failed", (() => { const r = mapFlouciVerify({ result: { status: "SYSTEM_FAILURE" } }, OK); return r.ok && r.status === "failed"; })());
check("flouci PENDING → pending", (() => { const r = mapFlouciVerify({ success: true, result: { status: "PENDING" } }, OK); return r.ok && r.status === "pending"; })());
check("flouci PREAUTH_SUCCESS → pending", (() => { const r = mapFlouciVerify({ success: true, result: { status: "PREAUTH_SUCCESS" } }, OK); return r.ok && r.status === "pending"; })());
check("flouci paid but no amount → paid + amountMinor null (fail-closed downstream)", (() => { const r = mapFlouciVerify({ success: true, result: { status: "SUCCESS" } }, OK); return r.ok && r.status === "paid" && r.amountMinor === null; })());
check("flouci !res.ok → not ok", !mapFlouciVerify({ result: { status: "SUCCESS" } }, BAD).ok);
check("flouci missing result → not ok", !mapFlouciVerify({ success: true }, OK).ok);

// ── ClicToPay (getOrderStatusExtended.do — lowercase orderStatus/amount) ───────
check("clictopay orderStatus 2 → paid 50000", (() => { const r = mapClictopayVerify({ errorCode: "0", orderStatus: 2, amount: 50000 }); return r.ok && r.status === "paid" && r.amountMinor === 50000; })());
check("clictopay 2 + STRING amount → coerced", (() => { const r = mapClictopayVerify({ orderStatus: 2, amount: "50000" }); return r.ok && r.amountMinor === 50000; })());
check("clictopay 6 → failed", (() => { const r = mapClictopayVerify({ orderStatus: 6 }); return r.ok && r.status === "failed"; })());
check("clictopay 3 → cancelled", (() => { const r = mapClictopayVerify({ orderStatus: 3 }); return r.ok && r.status === "cancelled"; })());
check("clictopay 4 → cancelled", (() => { const r = mapClictopayVerify({ orderStatus: 4 }); return r.ok && r.status === "cancelled"; })());
check("clictopay 5 (3DS) / 0 / 1 → pending", (() => { const a = mapClictopayVerify({ orderStatus: 5 }); const b = mapClictopayVerify({ orderStatus: 0 }); return a.ok && a.status === "pending" && b.ok && b.status === "pending"; })());
check("clictopay no orderStatus → pending", (() => { const r = mapClictopayVerify({ errorCode: "0" }); return r.ok && r.status === "pending"; })());
// CTP-08: a non-existent orderId returns a non-zero errorCode → not ok (don't settle, don't crash).
check("clictopay errorCode != 0 → not ok (CTP-08)", !mapClictopayVerify({ errorCode: "6", errorMessage: "Order not found" }).ok);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
