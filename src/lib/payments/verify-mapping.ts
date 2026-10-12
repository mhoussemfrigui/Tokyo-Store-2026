import type { VerifyResult, VerifyStatus } from "./shared";

/**
 * PURE response→VerifyResult mappers for the three gateways' verify calls.
 *
 * Kept dependency-free (no `db`, no `fetch`, no `server-only`) so the
 * money-critical status + amount parsing can be unit-tested without the network
 * or DB — and so all three providers share ONE consistent amount-coercion. The
 * provider clients do the fetch + JSON parse, then hand the parsed body here.
 *
 * Why this matters: `confirmPayment` FAILS CLOSED on a null amount (treats it as
 * an amount mismatch and refuses to settle). So an amount the gateway serialised
 * as a numeric STRING (gateways commonly do) must be coerced, or a genuinely-paid
 * order is stranded `pending` forever on every verify (webhook, return page, AND
 * the reconcile cron).
 */

/** First numeric (or numeric-string) candidate → integer minor units, else null. */
export function coerceAmountMinor(...candidates: unknown[]): number | null {
  for (const v of candidates) {
    if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      if (Number.isFinite(n)) return Math.round(n);
    }
  }
  return null;
}

/**
 * PURE post-verify settlement decision for `confirmPayment` — given an order's
 * already-resolved gateway verify outcome and the expected amount (millimes),
 * decide what the workflow should do. Extracted so the money-critical branching
 * (status gate + the fail-CLOSED amount guard) is unit-testable without the DB /
 * network / claim ledger.
 *
 *   - `noop_status` — the gateway doesn't report `paid` (still pending, failed,
 *     cancelled). Echo the status; the workflow leaves the order untouched (the
 *     return-page UI / reconcile cron act on `failed`/`cancelled`).
 *   - `amount_mismatch` — paid, but the reported amount is null/non-numeric or
 *     ≠ expected. FAIL CLOSED: never settle (a null amount is a mismatch, NOT a
 *     "skip the check").
 *   - `settle` — paid AND the amount matches exactly.
 *
 * NOTE: the workflow still short-circuits an ALREADY-settled order (status ≠
 * `pending`) BEFORE calling the gateway, so that case never reaches here.
 */
export type ConfirmDecision =
  | { action: "noop_status"; status: VerifyStatus }
  | { action: "amount_mismatch" }
  | { action: "settle" };

export function decideConfirmation(
  verify: { status: VerifyStatus; amountMinor: number | null },
  expectedMinor: number,
): ConfirmDecision {
  if (verify.status !== "paid") return { action: "noop_status", status: verify.status };
  if (verify.amountMinor == null || verify.amountMinor !== expectedMinor) {
    return { action: "amount_mismatch" };
  }
  return { action: "settle" };
}

type FlouciBody = { success?: boolean; result?: { status?: string; amount?: number | string } } | null;

export function mapFlouciVerify(data: FlouciBody, res: { ok: boolean; status: number }): VerifyResult {
  if (!res.ok || !data?.result) {
    return { ok: false, error: `Flouci verify a échoué (HTTP ${res.status}).` };
  }
  const st = String(data.result.status ?? "").toUpperCase();
  // PAID on status SUCCESS unless the envelope `success` is EXPLICITLY false.
  // (Docs say verify both, but the verify-response `success` flag can be absent;
  // treating absent as OK avoids stranding a paid order, and confirmPayment's
  // fail-closed amount guard still protects against under/mis-payment.)
  let status: VerifyStatus;
  if (st === "SUCCESS" && data.success !== false) status = "paid";
  else if (st === "FAILURE" || st === "EXPIRED" || st === "SYSTEM_FAILURE") status = "failed";
  else status = "pending"; // PENDING / PREAUTH_SUCCESS
  const amountMinor = coerceAmountMinor(data.result.amount);
  if (status === "paid" && amountMinor === null) {
    console.warn("[flouci] verify: status=SUCCESS but no parseable result.amount — order will NOT auto-settle.");
  }
  return { ok: true, status, amountMinor, currency: "TND" };
}

type ClictopayBody = {
  errorCode?: string | number;
  errorMessage?: string;
  orderStatus?: number;
  amount?: number | string;
} | null;

/**
 * getOrderStatusExtended.do response → VerifyResult (ClicToPay Basic 1.0).
 * A non-zero `errorCode` (absent = 0 = success) means the consultation itself
 * failed (orderId not found / bad creds / system) — we couldn't read the status,
 * so report it as a gateway error and DON'T settle (covers recette CTP-08, a
 * non-existent orderId, without crashing). Otherwise map `orderStatus`.
 */
export function mapClictopayVerify(r: ClictopayBody): VerifyResult {
  const err = r?.errorCode;
  if (err != null && String(err) !== "0") {
    return { ok: false, error: r?.errorMessage || `ClicToPay statut: erreur ${err}.` };
  }
  const s = r?.orderStatus;
  // orderStatus 2 = paid (the ONLY success), 6 = declined, 3 = auth cancelled,
  // 4 = refunded, 0/1/5/7 (registered / pre-auth / 3DS-in-progress / system) =
  // pending — anything ≠ 2 is "payment not abouti" per the manual.
  const status: VerifyStatus = s === 2 ? "paid" : s === 6 ? "failed" : s === 3 || s === 4 ? "cancelled" : "pending";
  return { ok: true, status, amountMinor: coerceAmountMinor(r?.amount), currency: "788" };
}
