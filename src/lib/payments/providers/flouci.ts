import "server-only";

import { resolvePaymentConfig } from "../config";
import { mapFlouciVerify } from "../verify-mapping";
import { GATEWAY_HTTP_TIMEOUT_MS, gatewayFetchErrorMessage } from "../gateway-rules";
import {
  toGatewayMinor,
  type InitiateInput,
  type InitiateResult,
  type VerifyResult,
} from "../shared";

/**
 * Flouci (https://developers.flouci.com) — JSON REST API **v2**.
 *
 * Verified against the live Flouci docs (docs.flouci.com, api-reference) AND the
 * official Flouci WooCommerce plugin v2.0.1:
 *
 *   AUTH (both calls): a SINGLE header
 *     `Authorization: Bearer <app_token>:<app_secret>`  (HTTPS only)
 *
 *   INIT:  POST /api/v2/generate_payment   (Content-Type: application/json)
 *     body: { amount (string, MILLIMES), success_link, fail_link, webhook?,
 *             accept_card (bool), session_timeout_secs, developer_tracking_id }
 *     → { result: { success, payment_id, link, developer_tracking_id }, code, version }
 *     Redirect the customer to `result.link`; keep `result.payment_id` as the ref.
 *
 *   VERIFY: GET /api/v2/verify_payment/{payment_id}
 *     → { success, result: { status, amount, settlement_status, … } }
 *     PAID only when top-level `success === true` AND `result.status === "SUCCESS"`.
 *     Statuses: SUCCESS | PENDING | EXPIRED | FAILURE | PREAUTH_SUCCESS |
 *               SYSTEM_FAILURE. Amount (millimes) at `result.amount`.
 *
 * Amount is integer millimes both sides (toGatewayMinor is identity for TND).
 * Credentials resolve via resolvePaymentConfig (env force-overrides the admin DB
 * value).
 */

const FLOUCI_API = "https://developers.flouci.com/api/v2";

/** The single Bearer header Flouci v2 authenticates every call with. */
function authHeader(appToken: string, appSecret: string): string {
  return `Bearer ${appToken}:${appSecret}`;
}

export async function initiatePayment(input: InitiateInput): Promise<InitiateResult> {
  const c = await resolvePaymentConfig("flouci");
  if (!c.appToken || !c.appSecret) {
    return { ok: false, error: "Flouci non configuré (FLOUCI_APP_TOKEN / FLOUCI_APP_SECRET)." };
  }
  try {
    const res = await fetch(`${FLOUCI_API}/generate_payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader(c.appToken, c.appSecret),
      },
      body: JSON.stringify({
        amount: String(toGatewayMinor(input.amountCents, input.currency)),
        success_link: input.returnUrl,
        fail_link: input.returnUrl,
        // Server-to-server confirmation callback (real-time settlement). The
        // return-page verify + the reconcile cron are the backups.
        ...(input.webhookUrl ? { webhook: input.webhookUrl } : {}),
        accept_card: true,
        session_timeout_secs: 1200,
        developer_tracking_id: input.orderId,
      }),
      // Bounded (a hung Flouci would otherwise block checkout for minutes); an
      // abort throws → the catch below → `ok:false` (gateway_error).
      signal: AbortSignal.timeout(GATEWAY_HTTP_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => null)) as
      | { result?: { link?: string; payment_id?: string }; message?: string }
      | null;
    const link = data?.result?.link;
    const paymentId = data?.result?.payment_id;
    if (!res.ok || !link || !paymentId) {
      return { ok: false, error: data?.message || `Flouci init a échoué (HTTP ${res.status}).` };
    }
    return { ok: true, redirectUrl: link, reference: paymentId };
  } catch (e) {
    return { ok: false, error: gatewayFetchErrorMessage("Flouci", e, "Flouci init failed") };
  }
}

export async function verifyPayment(reference: string): Promise<VerifyResult> {
  const c = await resolvePaymentConfig("flouci");
  if (!c.appToken || !c.appSecret) return { ok: false, error: "Flouci non configuré." };
  try {
    const res = await fetch(`${FLOUCI_API}/verify_payment/${encodeURIComponent(reference)}`, {
      headers: { Authorization: authHeader(c.appToken, c.appSecret) },
      signal: AbortSignal.timeout(GATEWAY_HTTP_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => null)) as
      | { success?: boolean; result?: { status?: string; amount?: number | string } }
      | null;
    // Status + amount parsing lives in the pure, unit-tested mapper.
    return mapFlouciVerify(data, res);
  } catch (e) {
    return { ok: false, error: gatewayFetchErrorMessage("Flouci", e, "Flouci verify failed") };
  }
}
