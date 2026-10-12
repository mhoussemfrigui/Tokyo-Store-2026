import { handleGatewayWebhook } from "@/lib/payments/webhook-handler";

/**
 * ClicToPay / Monétique Tunisie payment webhook — the silent server-to-server
 * confirmation callback.
 *   GET/POST /api/webhooks/clictopay?orderId=...
 *
 * ClicToPay POSTs/redirects here (the `dynamicCallbackUrl` passed to register.do)
 * when an order reaches a terminal state. The payload is NOT trusted: the shared
 * handler ([src/lib/payments/webhook-handler.ts]) resolves the order by the
 * stored gateway reference (the ClicToPay `orderId`) and re-verifies against
 * `getOrderStatusExtended.do` inside `confirmPayment` (amount check + idempotent
 * transition, with a per-order dedup). Gives ClicToPay real-time settlement; the
 * customer-return verify on `/order/[id]` and the `/api/cron/payments` reconcile
 * sweep stay the backups (e.g. a closed return tab).
 *
 * Mirrors the Flouci webhook ([src/app/api/webhooks/flouci/route.ts]); both go
 * through the SAME handler so signature/idempotency/rate-limit behaviour is
 * identical. ClicToPay sends the reference as `orderId` (or `mdOrder`), both of
 * which the handler's REF_QUERY_KEYS now cover.
 */
// DB + node-only (node-postgres); never cache a settlement callback. Runs on the
// default Node runtime (an explicit `runtime` export is incompatible with
// experimental.useCache).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleGatewayWebhook(request, "clictopay");
}

export async function POST(request: Request) {
  return handleGatewayWebhook(request, "clictopay");
}
