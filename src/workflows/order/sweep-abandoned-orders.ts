import "server-only";

import { orderService } from "@/modules/order/service";
import { posIntEnv } from "@/lib/db/env-num";
import { ok, workflow } from "../shared";
import { transitionOrderStatusWorkflow } from "./transition-status";
import { assertPendingOnlineOrderNotCaptured } from "./gateway-payment";

/**
 * Abandoned-order sweep — the GENERIC reserved-stock backstop.
 *
 * Tokyo reserves stock at order CREATION (place-order decrements inside the txn),
 * so an order left `pending` forever silently holds inventory. The
 * payment-reconcile cron only rescues ONLINE orders that carry a gateway
 * reference and are within its 24h window, and only on a DEFINITIVE gateway
 * decline — it never releases the stock of:
 *   • COD orders the operator never confirmed,
 *   • online orders that never reached a gateway reference (initiate failed), or
 *   • any order aged out of the reconcile window.
 *
 * Orders someone has taken charge of are NEVER swept (see
 * `orderService.listAbandonedPending`): operator-confirmed orders (a confirmed
 * COD order stays `pending` until « En préparation »), ERP-pushed orders
 * (`external_ref`), and point-less counter sales settled offline (caisse
 * « Non payé »). They wait for an operator to advance or cancel them. A pickup
 * naming a point (a shopper's « Drive » / « Retrait en magasin » COD order) is
 * swept like an unconfirmed home COD order.
 *
 * This sweep cancels the remaining orders stuck `pending` past
 * `ABANDONED_ORDER_HOURS` (default 48h) — beyond any live gateway session
 * (~20-30 min) AND the reconcile window (24h). Before cancelling an ONLINE
 * order that carries a gateway
 * reference it runs the shared fail-closed pre-flight
 * (`assertPendingOnlineOrderNotCaptured`): a paid-but-unsettled capture (missed
 * webhook, or stranded past the reconcile window) is SKIPPED, never blind-
 * cancelled — so the sweep can't reverse loyalty/promos + restock while the shop
 * keeps the money. COD / no-reference orders short-circuit to safe. Cancellation
 * routes through `transitionOrderStatusWorkflow`, so the existing restock +
 * loyalty/promo reversal fires (pending→cancelled is allowed in both graphs).
 * Idempotent + race-safe (the transition re-locks the row).
 *
 * Triggered by `POST /api/cron/abandoned-orders` (guardCron) through the shared
 * job center (kill-switch + run-now parity). Mirrors WooCommerce's
 * `wc_cancel_unpaid_orders` hold-stock backstop.
 */
// posIntEnv rejects blank / non-numeric / zero / negative (all of which the old
// `Number(...) || 48` either silently accepted, e.g. a negative, or masked) and
// falls back to 48 — the class of misconfig posIntEnv exists to prevent.
const ABANDON_HOURS = posIntEnv(process.env.ABANDONED_ORDER_HOURS, 48);
const MAX_BATCH = 200;

export const sweepAbandonedOrdersWorkflow = workflow<
  [Record<string, never>, { actorUserId?: string | null }],
  { checked: number; cancelled: number; skipped: number }
>("order.sweep_abandoned", async () => {
  const stale = await orderService.listAbandonedPending(ABANDON_HOURS, MAX_BATCH);
  let cancelled = 0;
  let skipped = 0;
  for (const o of stale) {
    // Fail-closed pre-flight: an online order carrying a gateway reference could be a
    // paid-but-unsettled capture (webhook missed, or stranded past the reconcile
    // window). Re-verify before cancelling and SKIP unless the gateway DEFINITIVELY
    // reports it unpaid — never blind-cancel a possible capture. COD / no-reference
    // orders short-circuit to { ok:true } and are cancelled as before.
    const safety = await assertPendingOnlineOrderNotCaptured(o, { actorUserId: null }).catch(
      () => ({ ok: false }) as const,
    );
    if (!safety.ok) {
      skipped++;
      continue;
    }
    const t = await transitionOrderStatusWorkflow(
      {
        orderId: o.id,
        toStatus: "cancelled",
        notes: `Commande abandonnée (en attente > ${ABANDON_HOURS} h) — annulée automatiquement, stock restitué.`,
      },
      { actorUserId: null },
    ).catch(() => null);
    if (t?.ok) cancelled++;
  }
  return ok({ checked: stale.length, cancelled, skipped });
});
