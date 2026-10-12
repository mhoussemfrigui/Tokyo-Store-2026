import "server-only";

import { orderService } from "@/modules/order/service";
import { webhookEventService, type WebhookProvider } from "@/modules/webhook";
import { ok, workflow } from "../shared";
import { confirmPaymentWorkflow } from "./gateway-payment";
import { transitionOrderStatusWorkflow } from "./transition-status";

/**
 * Reconcile stuck ONLINE-payment orders — the async-settlement rescue.
 *
 * Two failure modes leave an online order stranded `pending`:
 *   1. The customer closed the return tab AND no webhook arrived. Both gateways
 *      post a settlement webhook (Flouci's `webhook`, ClicToPay's
 *      `dynamicCallbackUrl`), but a missed/disabled one (the admin « Webhooks
 *      entrants » switch gates both) leaves the paid order pending until
 *      re-verified.
 *   2. A crash / redeploy between the `webhook_events` claim-commit and the
 *      status transition left an ORPHANED claim that blocks every retry (the
 *      claim wins, the transition never completes).
 *
 * For each online order pending within [`STALE_MINUTES`, `MAX_AGE_HOURS`] that
 * carries a gateway reference we RELEASE any orphaned `paid` claim (safe — a
 * genuinely-settled order is no longer `pending`, and this query only returns
 * pending rows) then re-run `confirmPayment`, which re-verifies against the
 * gateway API and settles exactly once (idempotent via the re-claim + the
 * order-status guard).
 *
 * When the gateway reports a DEFINITIVE terminal decline (`failed`/`cancelled`)
 * we auto-cancel the order (terminal `cancelled` status — restocks + reverses
 * loyalty/promos) so a declined payment doesn't sit `pending` forever,
 * indistinguishable from a brand-new unpaid one. We branch ONLY on those two
 * terminal verdicts: a still-`pending` gateway answer, an `amount_mismatch`
 * (returns `!ok`), or any transient `gateway_error` leaves the order alone so a
 * slow-paying / transient-error customer is never cancelled out from under them.
 * The return-page UI is what informs a PRESENT customer (the cron only sees
 * orders already stale by `STALE_MINUTES`); the cron is the backstop for an
 * absent one. An order the gateway still reports unpaid stays pending; past
 * `MAX_AGE_HOURS` (gateway session long expired) it's abandoned and drops out of
 * the candidate set so it can't starve freshly-stuck orders.
 *
 * Triggered by `POST /api/cron/payments` (guardCron). Idempotent + safe to run
 * frequently.
 */
const STALE_MINUTES = Number(process.env.PAYMENT_RECONCILE_STALE_MINUTES) || 20;
const MAX_AGE_HOURS = Number(process.env.PAYMENT_RECONCILE_MAX_AGE_HOURS) || 24;
const MAX_BATCH = 200;

export const reconcilePendingPaymentsWorkflow = workflow<
  [Record<string, never>, { actorUserId?: string | null }],
  { checked: number; settled: number; cancelled: number }
>("order.reconcile_pending_payments", async () => {
  const stale = await orderService.listStalePendingOnline(STALE_MINUTES, MAX_AGE_HOURS, MAX_BATCH);
  let settled = 0;
  let cancelled = 0;
  for (const o of stale) {
    // The query already constrains payment_method to ONLINE_METHODS + non-null
    // reference; this guard just narrows the nullable types for the calls below.
    if (!o.payment_reference || !o.payment_method) continue;
    // Release any orphaned `paid` claim before re-confirming — the order is still
    // pending well past the staleness window, so a held claim means a prior
    // settle crashed mid-way and no retry could pass it (GZ-1).
    await webhookEventService
      .release(o.payment_method as WebhookProvider, o.payment_reference, "paid")
      .catch(() => {});
    const res = await confirmPaymentWorkflow({ orderId: o.id }, { actorUserId: null }).catch(
      () => null,
    );
    if (!res?.ok) continue; // gateway_error / amount_mismatch → leave pending
    if (res.data.status === "paid") {
      settled++;
    } else if (res.data.status === "failed" || res.data.status === "cancelled") {
      // Definitive terminal decline at the gateway + the customer is long gone
      // (stale). Cancel so it stops re-polling and stops masquerading as a
      // fresh unpaid order; the transition restocks + reverses loyalty/promos.
      const t = await transitionOrderStatusWorkflow(
        {
          orderId: o.id,
          toStatus: "cancelled",
          notes: `Paiement ${res.data.status === "failed" ? "refusé" : "annulé"} au guichet (${o.payment_method}).`,
        },
        { actorUserId: null },
      ).catch(() => null);
      if (t?.ok) cancelled++;
    }
    // status "pending" / "already" → leave it for a later sweep or abandonment.
  }
  return ok({ checked: stale.length, settled, cancelled });
});
