import "server-only";

import { resolvePaymentConfig } from "../config";
import { mapClictopayVerify } from "../verify-mapping";
import {
  GATEWAY_HTTP_TIMEOUT_MS,
  clictopayOrderNumber,
  gatewayFetchErrorMessage,
} from "../gateway-rules";
import {
  toGatewayMinor,
  type InitiateInput,
  type InitiateResult,
  type VerifyResult,
} from "../shared";

/**
 * ClicToPay / Monétique Tunisie (SMT) — form-encoded REST API.
 *
 * Verified against the official "Manuel d'intégration ClicToPay API — Basic 1.0"
 * (CTP-API-BASIC-01):
 *   Flow: POST register.do → { orderId (UUID), formUrl }; redirect the customer
 *   to formUrl. Confirmation is the MANDATORY POST getOrderStatusExtended.do
 *   (NOT getOrderStatus.do) → `orderStatus === 2` is the ONLY success (0 =
 *   registered/unpaid, 1 = pre-auth, 3 = auth cancelled, 4 = refunded, 5 = 3DS
 *   in progress, 6 = declined, 7 = system error). Amount in millimes; TND
 *   currency code 788. Credentials resolve via resolvePaymentConfig (env
 *   force-overrides the admin/DB value).
 */

type Cfg = { userName: string; password: string; baseUrl: string };

async function clictopayConfig(): Promise<Cfg> {
  const c = await resolvePaymentConfig("clictopay");
  return {
    userName: c.userName,
    password: c.password,
    baseUrl: c.testMode
      ? "https://test.clictopay.com/payment/rest/"
      : "https://ipay.clictopay.com/payment/rest/",
  };
}

async function smtPost<T>(c: Cfg, endpoint: string, params: Record<string, string>): Promise<T> {
  const body = new URLSearchParams({ userName: c.userName, password: c.password, ...params });
  const res = await fetch(`${c.baseUrl}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    // Bounded (a hung SMT would otherwise block checkout for minutes); an
    // abort throws → the caller's catch → `ok:false` (gateway_error).
    signal: AbortSignal.timeout(GATEWAY_HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return { raw: text } as T;
  }
}

async function smtGet<T>(c: Cfg, endpoint: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams({ userName: c.userName, password: c.password, ...params }).toString();
  const res = await fetch(`${c.baseUrl}${endpoint}?${qs}`, {
    signal: AbortSignal.timeout(GATEWAY_HTTP_TIMEOUT_MS),
  });
  const text = await res.text();
  // Status reads only: an HTTP error / non-JSON body (proxy outage page) means
  // the status could NOT be read — throw so verify reports `ok:false` instead
  // of the mapper reading the empty object as "no orderStatus" → `pending`
  // (which the destructive-action guards may treat as unpaid).
  if (!res.ok) throw new Error(`ClicToPay statut illisible (HTTP ${res.status}).`);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`ClicToPay statut illisible (réponse non JSON, HTTP ${res.status}).`);
  }
}

export async function initiatePayment(input: InitiateInput): Promise<InitiateResult> {
  const c = await clictopayConfig();
  if (!c.userName || !c.password) {
    return { ok: false, error: "ClicToPay non configuré (CLICTOPAY_USERNAME / CLICTOPAY_PASSWORD)." };
  }
  try {
    const r = await smtPost<{
      orderId?: string;
      formUrl?: string;
      errorCode?: string;
      errorMessage?: string;
    }>(c, "register.do", {
      // orderNumber must be unique per merchant; a timestamp suffix lets a
      // re-init of the same order avoid the duplicate-orderNumber error
      // (register.do errorCode 1). AN..32 per the manual: the readable
      // `<order_number>-<ms>` is kept when it fits, compacted otherwise (a
      // 3–5-char admin order prefix would overflow → every init rejected).
      orderNumber: clictopayOrderNumber(input.orderNumber, Date.now()),
      amount: String(toGatewayMinor(input.amountCents, input.currency)), // millimes
      currency: "788", // TND (ISO 4217)
      returnUrl: input.returnUrl,
      failUrl: input.returnUrl, // both land on /order/[id]?pay=return, which re-verifies
      // Server-to-server confirmation callback (real-time settlement). SMT
      // posts the order status to `dynamicCallbackUrl` per the Basic API manual;
      // the handler re-verifies via getOrderStatusExtended.do regardless. Omit
      // the key entirely when no webhook URL is available (localhost is already
      // rejected upstream) so the gateway falls back to redirect-only.
      ...(input.webhookUrl ? { dynamicCallbackUrl: input.webhookUrl } : {}),
      description: `Commande ${input.orderNumber}`,
      language: "fr",
    });
    if (r.errorCode && r.errorCode !== "0") {
      return { ok: false, error: r.errorMessage || `ClicToPay erreur ${r.errorCode}.` };
    }
    if (!r.orderId || !r.formUrl) {
      return { ok: false, error: "ClicToPay: orderId/formUrl manquant." };
    }
    return { ok: true, redirectUrl: r.formUrl, reference: r.orderId };
  } catch (e) {
    return { ok: false, error: gatewayFetchErrorMessage("ClicToPay", e, "ClicToPay init failed") };
  }
}

export async function verifyPayment(reference: string): Promise<VerifyResult> {
  const c = await clictopayConfig();
  if (!c.userName || !c.password) return { ok: false, error: "ClicToPay non configuré." };
  try {
    const r = await smtGet<{
      errorCode?: string;
      errorMessage?: string;
      orderStatus?: number;
      amount?: number | string;
    }>(c, "getOrderStatusExtended.do", { orderId: reference, language: "fr" });
    // orderStatus → VerifyResult + errorCode handling (a non-zero errorCode means
    // the status couldn't be read — order not found / bad creds → don't settle)
    // lives in the pure, unit-tested mapper.
    return mapClictopayVerify(r);
  } catch (e) {
    return { ok: false, error: gatewayFetchErrorMessage("ClicToPay", e, "ClicToPay verify failed") };
  }
}
