import "server-only";

import { NextResponse } from "next/server";

import { workflows } from "@/workflows";
import { detectLateCaptureOnCancelledOrder } from "@/workflows/order/gateway-payment";
import { orderService } from "@/modules/order/service";
import { bus } from "@/events/bus";
import { apiSettingsService } from "@/modules/api-settings/service";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import type { WebhookProvider } from "@/modules/webhook";

/**
 * Shared silent server-to-server payment-webhook handler for BOTH online
 * gateways — `/api/webhooks/flouci` and `/api/webhooks/clictopay` (ClicToPay's
 * `dynamicCallbackUrl`) both route here, behind the same kill-switch.
 *
 * The gateway does NOT sign its callback, so we DON'T trust the request body. We
 * pull the gateway payment reference out of the query/body, look up the order we
 * stored that reference on at init time, and re-verify the payment against the
 * provider's API inside `confirmPayment` — which does the amount check and the
 * idempotent status transition. This is the REAL-TIME backup to the
 * customer-return verify on `/order/[id]` and the `/api/cron/payments` reconcile
 * sweep; whichever settles the order first makes the others a no-op.
 *
 *   - Kill-switch: admin-disabled webhooks → 503 (retryable signal).
 *   - Per-IP rate limit (the endpoint is unauthenticated) → 429 (fail-open on a
 *     limiter error so a real callback is never dropped).
 *   - Unmatched reference → 200 ack (+ ops event) so the gateway stops retrying
 *     (e.g. a callback that arrived before init persisted the reference).
 *   - Already-terminal order → 200 ack without re-confirming; on a CANCELLED
 *     order the gateway is re-verified (bounded) and a late capture is logged
 *     for a manual refund.
 *   - confirm failure → a TERMINAL outcome (amount mismatch, not-online, …) is
 *     200 (don't retry a no-op forever); a TRANSIENT one (verify API down, DB
 *     blip → `gateway_error` / transition error) is 503 so the gateway
 *     redelivers, preserving async settlement for a customer who closed the tab.
 */
// Per-provider gateway reference field names (query AND JSON body). Flouci sends
// `payment_id`; ClicToPay (SMT) sends the registered `orderId` (a.k.a. `mdOrder`
// on the redirect). Keep the union broad so a gateway's alternate shape still
// matches; the reference is re-verified against the gateway API regardless.
const REF_QUERY_KEYS = [
  "payment_ref",
  "paymentRef",
  "payment_id",
  "paymentId",
  "orderId",
  "mdOrder",
  "order_id",
] as const;

export async function handleGatewayWebhook(
  request: Request,
  provider: WebhookProvider,
): Promise<Response> {
  // Master webhooks switch. 503 (retryable) rather than a silent ack, so the
  // gateway may retry once webhooks are re-enabled; the customer-return verify
  // stays the primary settlement path meanwhile.
  const { webhooksEnabled } = await apiSettingsService.get();
  if (!webhooksEnabled) {
    return NextResponse.json(
      { error: "Webhooks désactivés." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Per-IP rate limit — unauthenticated endpoint, each hit costs a DB lookup +
  // a gateway verify. 429 is retryable; fail-open on a limiter error. The cap is
  // generous (a gateway sends every callback from a small set of egress IPs, so
  // a low cap would self-throttle a legitimate high-volume settlement burst);
  // replay is already deduped by the webhook_events idempotency claim.
  const ip = getClientIp(request.headers) || "anon";
  const rl = await checkRateLimit({
    bucket: `webhook:${provider}:${ip}`,
    max: 300,
    windowSeconds: 60,
  }).catch((err) => {
    // Fail-open so a limiter/DB blip never drops a real settlement callback —
    // but LOG it, or a sustained fail-open (an attacker stressing the DB to
    // disable throttling on this unauthenticated endpoint) leaves no trace.
    console.error(`[webhook:${provider}] rate-limit check failed, allowing (fail-open)`, err);
    return { ok: true } as { ok: boolean };
  });
  if (!rl.ok) {
    return NextResponse.json(
      { error: "Trop de requêtes." },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Extract the gateway reference: query first (Flouci ?payment_id), then a
  // JSON body (covers the provider's alternate shapes).
  const url = new URL(request.url);
  let ref: string | null = null;
  for (const k of REF_QUERY_KEYS) ref = ref ?? url.searchParams.get(k);
  if (!ref) {
    try {
      const body = (await request.json()) as {
        payment_ref?: string;
        paymentRef?: string;
        payment_id?: string;
        paymentId?: string;
        orderId?: string;
        mdOrder?: string;
        order_id?: string;
        data?: { payment_id?: string; id?: string; orderId?: string };
      };
      ref =
        body?.payment_ref ??
        body?.paymentRef ??
        body?.payment_id ??
        body?.paymentId ??
        body?.orderId ??
        body?.mdOrder ??
        body?.order_id ??
        body?.data?.payment_id ??
        body?.data?.orderId ??
        body?.data?.id ??
        null;
    } catch {
      /* no / invalid body — ref stays null */
    }
  }
  if (!ref) {
    return NextResponse.json({ error: "Missing payment reference" }, { status: 400 });
  }

  const order = await orderService.findByPaymentReference(ref, provider);
  if (!order) {
    bus
      .emit("webhook.payment.unmatched", {
        provider,
        paymentReference: ref,
        event: `${provider}_webhook`,
      })
      .catch(() => {});
    return NextResponse.json({ ok: true, ignored: true });
  }

  // Per-order idempotency: a gateway commonly redelivers the same callback (and an
  // attacker who learns a reference could replay it). The confirm workflow is
  // already idempotent (status guard + the webhook_events claim), but a settled
  // order would still re-enter it on every replay and re-run a gateway verify +
  // emit ops events — log/event amplification. Short-circuit here: only a STILL
  // pending order may be (re)confirmed; anything else is already terminal, so ack
  // 200 (stop the retries) without touching the workflow.
  if (order.status !== "pending") {
    // Except for the probe: a callback on a CANCELLED order may be a LATE capture
    // (the customer paid on a gateway page still open when the order was
    // cancelled) — money kept with no order. Re-verify (bounded per order) and
    // log it loudly for a manual refund; the ack stays 200 (nothing to settle).
    if (order.status === "cancelled") {
      await detectLateCaptureOnCancelledOrder(order, "webhook");
    }
    return NextResponse.json({ ok: true, status: "already", settled: true });
  }

  const result = await workflows.order.confirmPayment(
    { orderId: order.id },
    { actorUserId: null },
  );
  if (!result.ok) {
    console.warn(`[webhook:${provider}] confirm failed`, {
      orderId: order.id,
      error: result.error,
    });
    const TERMINAL = new Set(["amount_mismatch", "not_online", "not_initiated", "not_found"]);
    const httpStatus = TERMINAL.has(result.error) ? 200 : 503;
    return NextResponse.json({ ok: false, error: result.error }, { status: httpStatus });
  }
  return NextResponse.json({ ok: true, status: result.data.status });
}
