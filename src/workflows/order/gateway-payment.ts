import "server-only";

import { orderService } from "@/modules/order/service";
import { webhookEventService } from "@/modules/webhook";
import {
  initiateGatewayPayment,
  verifyGatewayPayment,
  isOnlineMethod,
  toGatewayMinor,
  fromGatewayMinor,
  type GatewayMethod,
} from "@/lib/payments/gateway";
import { bus } from "@/events/bus";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { decideConfirmation } from "@/lib/payments/verify-mapping";
import { isGatewaySessionPossiblyLive } from "@/lib/payments/gateway-rules";
import { checkRateLimit } from "@/lib/rate-limit";
import { fail, ok, workflow } from "../shared";
import { transitionOrderStatusWorkflow } from "./transition-status";

/**
 * Gateway payment lifecycle for online methods (ClicToPay / Flouci).
 *
 *   initiatePayment → create a gateway checkout session, store its reference on
 *                     the order, return the URL to redirect the customer to.
 *   confirmPayment  → re-verify the payment against the gateway API and, if
 *                     genuinely paid (+ amount matches), transition the order to
 *                     `paid` exactly once. Called from BOTH the customer return
 *                     (`/order/[id]?pay=return`) and the Flouci silent webhook,
 *                     so it is idempotent via the webhook_events claim.
 *
 * COD never touches this path — it is settled on delivery.
 */

/**
 * Resolve the PUBLIC origin the gateway must send the customer / webhook back
 * to — the shared `resolvePublicOrigin()` (admin `seo.site_url` ⟶ build-baked
 * `NEXT_PUBLIC_SITE_URL` ⟶ localhost), the SAME source the email subscribers,
 * sitemap, robots and canonical use. localhost is rejected for an actual payment
 * by the guard in `initiatePaymentWorkflow`.
 */
async function resolveOrigin(): Promise<string> {
  return resolvePublicOrigin();
}

/** True when an origin resolves to a localhost host (a dead return target). */
function isLocalhostOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return true; // unparseable → treat as unusable
  }
}

/**
 * Server-to-server webhook URL for a provider, or undefined for providers that
 * don't post one. Both online gateways now POST a real-time settlement callback:
 *   - Flouci    → `/api/webhooks/flouci` (the `webhook` field of generate_payment)
 *   - ClicToPay → `/api/webhooks/clictopay` (the `dynamicCallbackUrl` of register.do)
 * The customer-return verify + the `/api/cron/payments` reconcile sweep remain
 * the backups (e.g. a closed return tab).
 */
function webhookUrlFor(method: GatewayMethod, origin: string): string | undefined {
  if (method === "flouci") return `${origin}/api/webhooks/flouci`;
  if (method === "clictopay") return `${origin}/api/webhooks/clictopay`;
  return undefined;
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: full.trim(), lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export const initiatePaymentWorkflow = workflow<
  [{ orderId: string }, { actorUserId?: string | null }],
  { redirectUrl: string; reference: string }
>("order.initiate_payment", async ({ orderId }, { actorUserId }) => {
  const order = await orderService.findById(orderId);
  if (!order) return fail("not_found", "Commande introuvable.");
  if (order.status !== "pending") {
    return fail("not_pending", "Cette commande n'est plus en attente de paiement.");
  }
  const method = order.payment_method;
  if (!isOnlineMethod(method)) {
    return fail("not_online", "Cette commande n'utilise pas un paiement en ligne.");
  }
  // Nothing to charge (100 % coupon / free shipping): the gateways reject a 0
  // amount and a 0 capture could never be verified. Refused explicitly — the
  // caller settles such an order through `settleZeroTotalOrderWorkflow` instead
  // of redirecting to a gateway.
  const dueCents = order.total_cents;
  if (dueCents <= 0) {
    return fail("zero_amount", "Aucun montant à payer pour cette commande.");
  }

  // Resume / retry of an order that ALREADY minted a gateway session: verify
  // that session FIRST. Re-initiating overwrites `payment_reference`, and the
  // webhook / return page / reconcile only ever look up the CURRENT reference —
  // so a captured-but-not-yet-settled payment on the old session (webhook
  // delayed or disabled, return tab closed) would become unmatchable and the
  // order later auto-cancelled with the money kept. Same fail-CLOSED pre-flight
  // as the cancels: `paid` → settled right now (confirm's side effect) and the
  // re-init refused; a payment signal (amount mismatch) or an unverifiable
  // gateway → refused, the old reference left in place. Only a definitively
  // unpaid or still-open session (`failed` / `cancelled` / `pending`) re-inits.
  // The first init (checkout / quick-buy) has no reference yet → skipped.
  if (order.payment_reference) {
    const safety = await assertPendingOnlineOrderNotCaptured(
      order,
      { actorUserId },
      { allowLiveSession: true },
    );
    if (!safety.ok) {
      return fail(
        safety.error,
        safety.error === "already_paid"
          ? "Le paiement de cette commande a déjà été confirmé — aucun nouveau paiement n'est nécessaire."
          : safety.message,
      );
    }
  }

  // Resolve the public origin the gateway returns to. A localhost origin (env
  // unset/misbuilt AND no admin seo.site_url) would hand the gateway a dead
  // returnUrl → a successful payment would never settle. Fail LOUD at init
  // instead, so the operator sees a clear config error rather than silently
  // stranding every online order as pending.
  const origin = await resolveOrigin();
  if (isLocalhostOrigin(origin)) {
    return fail(
      "config",
      "URL du site non configurée — paiement en ligne indisponible. Définissez seo.site_url (admin) ou NEXT_PUBLIC_SITE_URL sur l'origine publique HTTPS.",
    );
  }

  const name = splitName(order.ship_full_name);
  const init = await initiateGatewayPayment(method, {
    orderId: order.id,
    orderNumber: order.order_number,
    // Charge the order total.
    amountCents: dueCents,
    currency: order.currency,
    email: order.contact_email,
    firstName: name.firstName,
    lastName: name.lastName,
    returnUrl: `${origin}/order/${order.id}?pay=return`,
    webhookUrl: webhookUrlFor(method, origin),
  });
  if (!init.ok) return fail("gateway_error", init.error);

  // Persist the gateway reference so the webhook + return handler can match
  // this order and the verify call has something to look up.
  await orderService.updatePaymentReference(order.id, init.reference, method);

  bus
    .emit(
      "order.payment_initiated",
      { orderId: order.id, provider: method, reference: init.reference },
      { actorUserId: actorUserId ?? null },
    )
    .catch(() => {});

  return ok({ redirectUrl: init.redirectUrl, reference: init.reference });
});

/** `payment_reference` stamped on an online order settled without a gateway. */
export const ZERO_TOTAL_PAYMENT_REFERENCE = "zero-total";

/**
 * Settle a pending ONLINE order with nothing left to collect — total 0 OR store
 * credit fully covering it, so no gateway session is (or can be) created
 * (`initiatePaymentWorkflow` refuses it with `zero_amount`). Moves it straight to
 * `paid` through the shared status workflow (row-locked; stamps paid_at /
 * confirmed_at, fires order.paid + the customer emails) with the
 * {@link ZERO_TOTAL_PAYMENT_REFERENCE} reference, so the order is not left
 * pending — coupon use held — until the abandoned-order sweep cancels it.
 * Re-checks every precondition itself: only a still-pending online order with
 * `total_cents === 0` is settled.
 */
export const settleZeroTotalOrderWorkflow = workflow<
  [{ orderId: string }, { actorUserId?: string | null }],
  { orderId: string }
>("order.settle_zero_total", async ({ orderId }, { actorUserId }) => {
  const order = await orderService.findById(orderId);
  if (!order) return fail("not_found", "Commande introuvable.");
  if (order.status !== "pending") {
    return fail("not_pending", "Cette commande n'est plus en attente de paiement.");
  }
  if (!isOnlineMethod(order.payment_method)) {
    return fail("not_online", "Cette commande n'utilise pas un paiement en ligne.");
  }
  if (order.total_cents !== 0) {
    return fail("not_zero_total", "Cette commande a un montant à payer.");
  }
  const result = await transitionOrderStatusWorkflow(
    {
      orderId: order.id,
      toStatus: "paid",
      paymentReference: ZERO_TOTAL_PAYMENT_REFERENCE,
      notes: "Montant nul — réglée sans paiement en ligne.",
    },
    { actorUserId: actorUserId ?? null },
  );
  if (!result.ok) return fail(result.error, result.message);
  return ok({ orderId: order.id });
});

type ConfirmStatus = "paid" | "pending" | "failed" | "cancelled" | "already";

export const confirmPaymentWorkflow = workflow<
  [{ orderId: string }, { actorUserId?: string | null }],
  { status: ConfirmStatus }
>("order.confirm_payment", async ({ orderId }, { actorUserId }) => {
  const order = await orderService.findById(orderId);
  if (!order) return fail("not_found", "Commande introuvable.");
  // Already settled — idempotent success (webhook + return can both fire).
  if (order.status !== "pending") return ok({ status: "already" });

  const method = order.payment_method;
  if (!isOnlineMethod(method)) return fail("not_online", "Paiement en ligne uniquement.");
  const reference = order.payment_reference;
  if (!reference) return fail("not_initiated", "Paiement non initié.");

  const verify = await verifyGatewayPayment(method, reference);
  if (!verify.ok) return fail("gateway_error", verify.error);

  // Pure decision: status gate + the fail-CLOSED amount guard. Both sides are
  // millimes (`*_cents` columns hold millimes; `toGatewayMinor` is identity for
  // TND). The gateway charged the order total, so we verify against that. A
  // missing/non-numeric gateway amount counts as a mismatch (never "skip the
  // check").
  const expectedCents = order.total_cents;
  const expectedMinor = toGatewayMinor(expectedCents, order.currency);
  const decision = decideConfirmation(verify, expectedMinor);
  if (decision.action === "noop_status") return ok({ status: decision.status });
  if (decision.action === "amount_mismatch") {
    bus
      .emit("webhook.payment.amount_mismatch", {
        provider: method,
        orderId: order.id,
        expectedCents,
        receivedCents: fromGatewayMinor(verify.amountMinor ?? 0, order.currency),
        currency: verify.currency,
      })
      .catch(() => {});
    return fail("amount_mismatch", "Le montant payé ne correspond pas à la commande.");
  }

  // Idempotency: only one confirmation transitions the order, even if the
  // webhook and the return page race for it.
  const claimed = await webhookEventService.claim(method, reference, "paid", order.id);
  if (!claimed) return ok({ status: "already" });

  try {
    const result = await transitionOrderStatusWorkflow(
      {
        orderId: order.id,
        toStatus: "paid",
        paymentReference: reference,
        notes: `${method} payment confirmed`,
      },
      { actorUserId: actorUserId ?? null },
    );
    if (!result.ok) {
      // Release so a gateway retry / page refresh can re-process.
      await webhookEventService.release(method, reference, "paid");
      return fail(result.error, result.message);
    }
    return ok({ status: "paid" });
  } catch (err) {
    // The transition THREW (e.g. a transient DB error mid-tx). The current code
    // path only released on a returned `!result.ok`, so a throw left the claim
    // committed → the order stranded `pending` with a held claim no retry could
    // pass. Release here so a gateway retry / return-page refresh / the
    // reconcile cron (order.reconcile_pending_payments) can re-process. A
    // process-death between claim-commit and transition-commit is the residual
    // case the reconcile cron covers (it releases orphaned claims on still-
    // pending orders before re-confirming).
    await webhookEventService.release(method, reference, "paid").catch(() => {});
    throw err;
  }
});

/** Result of the destructive-action pre-flight below. */
export type CancelSafety = { ok: true } | { ok: false; error: string; message: string };

/**
 * Fail-CLOSED pre-flight shared by EVERY destructive exit on a pending ONLINE order —
 * the customer « Annuler » (`cancelMyPendingOrderAction`), the admin status dropdown
 * (`transitionOrderStatusAction`; bulk status changes refuse `cancelled`), every
 * `pending → cancelled` through `transitionOrderStatusWorkflow` (incl. the external
 * order API), the abandoned-order sweep (`sweepAbandonedOrdersWorkflow`), and the
 * session re-init of « Reprendre le paiement » (`initiatePaymentWorkflow`, which would
 * otherwise overwrite a captured reference). Re-verify the gateway and allow the action
 * ONLY when the payment is DEFINITIVELY not captured. Any uncertainty REFUSES:
 *   • `paid` / `already`                      → a real capture (settled now, or held behind
 *                                               an orphaned `paid` claim) → refuse.
 *   • `amount_mismatch` / `tracking_mismatch` → money moved, wrong amount → refuse.
 *   • `pending` on a session that may still be OPEN (last (re)initiation younger than
 *     `GATEWAY_SESSION_WINDOW_MS`) → the customer may be on the payment page / in 3DS
 *     right now and capture seconds after the cancel → refuse (`payment_in_progress`),
 *     unless `opts.allowLiveSession` (the re-init itself, which never destroys the order).
 *   • `gateway_error` / internal / threw      → could NOT prove it unpaid → refuse (fail CLOSED).
 * so a transient gateway outage can never strand a real payment (the F3 hole where a
 * bare `if (paid || already)` guard would FALL OPEN on a verify failure and cancel a
 * genuinely-paid order, reversing loyalty/credit/promos + restocking while the shop keeps
 * the capture).
 *
 * Returns { ok:true } when there is nothing to verify (COD / no gateway reference) or the
 * gateway confirms a non-captured state (`failed` / `cancelled`, or a `pending` whose
 * session has expired). Stricter than `reconcilePendingPaymentsWorkflow`, which never acts
 * on `pending` at all. `order.updated_at` dates the last (re)initiation
 * (`updatePaymentReference` bumps it); absent → the session is assumed live (refuse).
 * `confirmPaymentWorkflow` is idempotent and, on a genuinely-paid verdict, SETTLES the
 * order to `paid` as a side effect — so this both DETECTS and RESCUES a stranded capture.
 *
 * NOTE: this verifies the order's CURRENT `payment_reference`. The rarer multi-tab strand
 * (a customer who resumed to ref B then paid the still-open ref A) needs an attempt-history
 * table to settle the older paid ref — tracked separately; this guard closes the common
 * webhook-missed / not-yet-settled capture case, and `detectLateCaptureOnCancelledOrder`
 * flags a capture that still lands on a cancelled order.
 */
export async function assertPendingOnlineOrderNotCaptured(
  order: {
    id: string;
    payment_method: string | null;
    payment_reference: string | null;
    updated_at?: Date | string | null;
  },
  ctx: { actorUserId?: string | null },
  opts: { allowLiveSession?: boolean } = {},
): Promise<CancelSafety> {
  // Only an online order that actually minted a gateway session can hold a capture.
  if (!order.payment_method || !isOnlineMethod(order.payment_method) || !order.payment_reference) {
    return { ok: true };
  }
  const confirmed = await confirmPaymentWorkflow({ orderId: order.id }, ctx).catch(() => null);
  // DEFINITIVELY-not-captured verdicts are the ONLY safe-to-destroy states.
  if (
    confirmed &&
    confirmed.ok &&
    (confirmed.data.status === "failed" || confirmed.data.status === "cancelled")
  ) {
    return { ok: true };
  }
  // `pending` = not captured YET. Safe only once the gateway session can no longer
  // be paid (expired), or for the re-init path that keeps the order alive anyway.
  if (confirmed && confirmed.ok && confirmed.data.status === "pending") {
    if (opts.allowLiveSession || !isGatewaySessionPossiblyLive(order.updated_at, Date.now())) {
      return { ok: true };
    }
    return {
      ok: false,
      error: "payment_in_progress",
      message:
        "Paiement en cours chez la banque (session de paiement encore ouverte) — réessayez plus tard.",
    };
  }
  // A genuine capture: settled just now, or reported paid but held behind an orphaned claim.
  if (
    confirmed &&
    confirmed.ok &&
    (confirmed.data.status === "paid" || confirmed.data.status === "already")
  ) {
    return {
      ok: false,
      error: "already_paid",
      message:
        "Le paiement en ligne de cette commande a été réglé — action impossible. Un remboursement doit passer par le support.",
    };
  }
  // A paid-but-wrong signal (amount mismatch): a payment exists, never destroy.
  if (
    confirmed &&
    !confirmed.ok &&
    (confirmed.error === "amount_mismatch" || confirmed.error === "tracking_mismatch")
  ) {
    return {
      ok: false,
      error: "payment_detected",
      message:
        "Un paiement a été détecté sur cette commande (montant à vérifier) — action impossible. Contactez le support.",
    };
  }
  // gateway_error / internal / null (threw) / any other fail → we could NOT prove the order
  // is unpaid. Fail CLOSED: refuse rather than risk stranding a capture.
  return {
    ok: false,
    error: "payment_unverified",
    message: "Vérification du paiement indisponible — réessayez dans un instant.",
  };
}

/**
 * Late-capture probe for a CANCELLED online order — a gateway callback (webhook) or a
 * customer return (`/order/[id]?pay=return`) that lands AFTER the order was cancelled.
 * `confirmPaymentWorkflow` answers `already` for any non-pending order and reconcile /
 * sweep only list pending ones, so a payment captured on a still-open gateway page after
 * the cancel (the one case where the shop keeps money with no order, stock already
 * restocked) would otherwise go completely unnoticed. Re-verifies the stored reference and,
 * when the gateway reports it PAID, logs a structured ERROR for the operator to refund
 * manually — never auto-mutates the cancelled order (a terminal status). Returns true on a
 * verified capture (the order page then tells the customer to contact the shop). An order
 * that was SETTLED before its cancellation (`paid_at` set) is skipped: that capture is
 * known and goes through the refund flow.
 *
 * Bounded per order (unauthenticated webhook replays / return-page reloads must not become
 * unbounded gateway calls); a limiter error skips the probe. Never throws.
 * (Alerting through an event / notification is deferred — structured log only.)
 */
export async function detectLateCaptureOnCancelledOrder(
  order: {
    id: string;
    order_number: string;
    status: string;
    payment_method: string | null;
    payment_reference: string | null;
    total_cents: number;
    currency: string;
    paid_at: Date | string | null;
  },
  source: "webhook" | "return",
): Promise<boolean> {
  const method = order.payment_method;
  const reference = order.payment_reference;
  if (order.status !== "cancelled" || order.paid_at != null) return false;
  if (!isOnlineMethod(method) || !reference) return false;
  try {
    const rl = await checkRateLimit({
      bucket: `late-capture:${order.id}`,
      max: 5,
      windowSeconds: 3600,
    }).catch(() => ({ ok: false }));
    if (!rl.ok) return false;
    const verify = await verifyGatewayPayment(method, reference);
    if (!verify.ok) {
      console.warn("[payment] callback/return on a CANCELLED order — capture could not be verified", {
        source,
        provider: method,
        orderId: order.id,
        orderNumber: order.order_number,
        reference,
        error: verify.error,
      });
      return false;
    }
    if (verify.status !== "paid") return false;
    console.error(
      "[payment] LATE CAPTURE on a CANCELLED order — the gateway reports it PAID; refund the customer manually",
      {
        source,
        provider: method,
        orderId: order.id,
        orderNumber: order.order_number,
        reference,
        paidMinor: verify.amountMinor,
        // The gateway was charged the order total — mirror the real verification
        // above (expectedCents = total_cents).
        expectedMinor: toGatewayMinor(order.total_cents, order.currency),
        currency: verify.currency,
      },
    );
    return true;
  } catch (err) {
    console.warn("[payment] late-capture probe failed", { source, orderId: order.id, err });
    return false;
  }
}
