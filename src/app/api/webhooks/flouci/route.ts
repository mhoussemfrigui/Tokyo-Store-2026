import { handleGatewayWebhook } from "@/lib/payments/webhook-handler";

/**
 * Flouci payment webhook — the silent server-to-server confirmation callback.
 *   GET/POST /api/webhooks/flouci?payment_id=...
 *
 * Flouci POSTs here (the `webhook` URL passed to generate_payment) when a
 * payment is confirmed. The payload is NOT trusted: the shared
 * handler ([src/lib/payments/webhook-handler.ts]) resolves the order by the
 * stored `payment_id` and re-verifies against Flouci's `verify_payment` API
 * inside `confirmPayment` (amount check + idempotent transition). Gives Flouci
 * real-time settlement; the customer-return verify on `/order/[id]` and the
 * `/api/cron/payments` reconcile sweep are the backups (e.g. a closed return tab).
 */
// DB + node-only (node-postgres); never cache a settlement callback. Runs on the
// default Node runtime (the default is already nodejs; an explicit `runtime`
// export is incompatible with experimental.useCache).
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleGatewayWebhook(request, "flouci");
}

export async function POST(request: Request) {
  return handleGatewayWebhook(request, "flouci");
}
