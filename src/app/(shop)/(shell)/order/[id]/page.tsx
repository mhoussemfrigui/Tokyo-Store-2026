import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { formatMoneyExact } from "@/lib/price";
import { orderTaxIncludedInTotal } from "@/lib/order/order-tax-mode";
import { getActiveCurrency } from "@/lib/currency/active";
import { formatTaxRate, getTaxConfig } from "@/lib/tax";
import { isOnlineMethod } from "@/lib/payments/shared";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Download,
  Package,
  XCircle,
} from "lucide-react";
import { PendingOnlineControls } from "./pending-online-controls";

import { findOrderById, listItemsForOrder } from "@/modules/order/queries";
import { isUuid } from "@/lib/utils/uuid";
import { generateOrderQrDataUrl } from "@/lib/qr/order-qr";
import { getCurrentUser } from "@/lib/auth/session";
import { workflows } from "@/workflows";
import { detectLateCaptureOnCancelledOrder } from "@/workflows/order/gateway-payment";
import { shouldTrackGatewayReturnPurchase } from "@/lib/payments/gateway-rules";
import { checkRateLimit } from "@/lib/rate-limit";
import { PurchaseTrack } from "@/components/storefront/purchase-track";

export const metadata: Metadata = {
  title: "Commande confirmée",
  robots: { index: false, follow: false },
};

/**
 * Order confirmation page — shown immediately after a successful checkout.
 *
 * The order SUMMARY (status, items, totals, shipping) is UUID-accessible: the
 * IDs are UUID v7 — ~74 random bits (+ a ms creation timestamp), unguessable but
 * a BEARER capability, so never leak them (third-party tags get a scrubbed
 * `/order/:id` — src/lib/tracking/redact-url.ts) — and the pattern (Medusa,
 * Shopify, Stripe) is well-established. This keeps guest checkouts working
 * without an account, lets the success URL be shared with the delivery rider,
 * and lets the QR scan target reuse the same path.
 *
 * The `purchase` funnel event fires client-side (PurchaseTrack) on the COD
 * confirmation (`?fresh=1`) and on the gateway return (`?pay=return`) that
 * finds the online payment captured. Server-side ordering events go through
 * `bus.emit` in the workflow.
 */
export default async function OrderConfirmationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fresh?: string; pay?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  if (!isUuid(id)) notFound();

  // Returning from a gateway redirect (?pay=return) — verify + settle the
  // payment server-side before rendering, so the customer sees the updated
  // status immediately. The Flouci silent webhook is the async backup; both
  // are idempotent so whichever runs first wins. We CAPTURE the result (was
  // swallowed) so a decline/cancel/amount-mismatch on return drives the header
  // + the retry/cancel controls instead of a silent "En attente de paiement".
  // Throttled per order: this GET is unauthenticated and the verify is an
  // outbound gateway call (API quota), so a hammered `?pay=return` just renders
  // the current DB status once over the cap — like the late-capture probe; the
  // webhook + reconcile cron still settle it. A limiter error fails open.
  const settleAllowed =
    sp.pay === "return" &&
    (
      await checkRateLimit({ bucket: `pay-return:${id}`, max: 10, windowSeconds: 60 }).catch(
        () => ({ ok: true }),
      )
    ).ok;
  const settleResult = settleAllowed
    ? await workflows.order
        .confirmPayment({ orderId: id }, { actorUserId: null })
        .catch(() => null)
    : null;
  // The gateway's verdict from THIS return (null otherwise). `failed`/`cancelled`
  // = a hard decline; an `amount_mismatch` fail() must NOT offer a naive retry
  // (re-initiating won't fix a wrong amount → tell the customer to contact us).
  const settleStatus = settleResult?.ok ? settleResult.data.status : null;
  const settleAmountMismatch =
    !!settleResult && !settleResult.ok && settleResult.error === "amount_mismatch";

  const order = await findOrderById(id).catch(() => null);
  if (!order) notFound();

  // Active currency label (Commandes → Devises) so the confirmation totals carry
  // the SAME currency the storefront/cart/checkout show. Exact precision kept (a
  // discounted total must not misprint). Relabel only — the millime scale stands.
  // DELIBERATE (audit 2026-09-26): this uses the LIVE label, while admin lists /
  // exports / the fiscal invoice read the `orders.currency` snapshot. On the
  // single-currency TND store the two always agree; if an operator ever changed
  // the active symbol, a revisited old order would show the new label here and
  // the sale-time label in admin. Amounts are identical either way (no
  // conversion), so this cosmetic divergence is accepted, not a bug.
  const currency = await getActiveCurrency();
  const TND = (cents: number) => formatMoneyExact(cents, currency.symbol, currency.symbolPosition);

  // Online-payment lifecycle flags. A pending COD order is "confirmed"
  // (settles at delivery); a pending ONLINE order still needs payment, so it
  // gets the retry/cancel controls + a non-celebratory header. A declined
  // return shows the refusal explicitly.
  const isOnline = isOnlineMethod(order.payment_method);
  const isPendingOnline = order.status === "pending" && isOnline;
  const paymentDeclined =
    isPendingOnline && (settleStatus === "failed" || settleStatus === "cancelled");
  // "Settled" for header purposes: anything past pending, OR a pending COD order
  // (which is legitimately confirmed). A pending online order is NOT settled.
  const isSettled = order.status !== "pending" || order.payment_method === "cod";
  // A cancelled / refunded order must never read as "Commande confirmée — Merci"
  // (e.g. right after the customer's own « Annuler la commande »).
  const isClosed = order.status === "cancelled" || order.status === "refunded";
  // Back from the gateway onto an order cancelled meanwhile: the customer may just
  // have PAID on a payment page still open at cancel time. Probe the gateway
  // (bounded, logs the late capture for a manual refund) so the page can say so.
  const lateCapture =
    sp.pay === "return" && order.status === "cancelled"
      ? await detectLateCaptureOnCancelledOrder(order, "return")
      : false;
  // `purchase` analytics: the COD confirmation (`?fresh=1`, settled-at-delivery)
  // and the gateway return that finds the online payment captured — `paid` when
  // THIS return settled it (exactly once), or `already` when the webhook beat the
  // browser back moments ago (PurchaseTrack's one-shot dedupes a replay).
  const trackPurchase =
    (sp.fresh === "1" && isSettled) ||
    (sp.pay === "return" &&
      isOnline &&
      shouldTrackGatewayReturnPurchase({
        settleStatus,
        orderStatus: order.status,
        paidAt: order.paid_at,
      }));
  // Only the order owner (registered) or any holder of a guest order's UUID may
  // resume/cancel — mirrors the secrets-access trust model (the actions re-check
  // server-side; this just gates whether the controls render).

  const viewer = await getCurrentUser();

  // Resume/cancel authorization: a registered order needs its owner; a guest
  // order (no user_id) trusts the UUID-holder, same as the summary itself. The
  // server actions re-enforce this — `canAct` only decides whether to RENDER the
  // controls (no point showing a button that will 403).
  const canAct = order.user_id ? viewer?.id === order.user_id : true;

  // Items + QR are independent — fetch in parallel.
  const [items, qrDataUrl] = await Promise.all([
    listItemsForOrder(order.id).catch(() => []),
    generateOrderQrDataUrl(order.id).catch(() => null),
  ]);

  // GA4 purchase-event scope: every order line counts toward the conversion.
  const purchaseItems = items;

  // ── TVA display. The amount + per-line rates are SNAPSHOTS frozen at sale
  // (`order.tax_cents`, `order_items.tax_rate_bps`) — never recomputed. We only
  // read the current config for the display LABEL, and infer whether the tax was
  // ADDED on top ("ht": tax is part of total) or already INCLUDED ("ttc": shown
  // as an informational "dont TVA" note) by checking the order's own arithmetic:
  // if removing the tax from the total still balances the other components, the
  // tax was included; otherwise it was an add-on. This stays correct even if the
  // admin later flips the tax mode.
  const taxConfig = await getTaxConfig().catch(() => null);
  const taxLabel = taxConfig?.label || "TVA";
  // Distinct snapshotted rates on the lines — a single shared rate annotates the
  // label ("TVA (19 %)"); mixed or absent rates show just the label.
  const orderTaxRates = Array.from(
    new Set(
      items
        .map((it) => it.tax_rate_bps)
        .filter((b): b is number => b != null && b > 0),
    ),
  );
  // The printed TVA is the manual override when set, else the computed tax —
  // the SAME expression the two admin pages (order detail + invoice) use, so the
  // customer confirmation never disagrees with the invoice.
  const effectiveTaxCents = order.tax_manual_cents ?? order.tax_cents;
  const taxIncludedInTotal = orderTaxIncludedInTotal(order);

  // The "Suivre ma commande" CTA targets the account tracking page, so it only
  // makes sense for the registered owner of this order (a guest UUID-holder has
  // no account view). Mirrors the medusa `user &&` gate.
  const isRegisteredOwner = !!viewer && viewer.id === order.user_id;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      {/* Funnel: `purchase` event, fired once on the COD `?fresh=1`
          confirmation or the captured gateway return (`trackPurchase` above).
          The query params are stripped client-side after firing and a
          per-order one-shot guards replays, so a back/forward navigation
          doesn't double-count. A not-yet-paid online order never counts
          (COD is settled-at-delivery, so its `?fresh=1` confirmation fires). */}
      {trackPurchase && purchaseItems.length > 0 && (
        <PurchaseTrack
          orderId={order.id}
          orderNumber={order.order_number}
          totalCents={order.total_cents}
          currency={order.currency}
          // value_cents (total) bakes in tax + shipping — break them out so GA4
          // revenue reconciles with item revenue (effectiveTaxCents honours the
          // manual override, matching the invoice).
          taxCents={effectiveTaxCents}
          shippingCents={order.shipping_cents}
          items={purchaseItems.map((it) => ({
            item_id: it.product_id,
            item_name: it.product_name,
            price_cents: it.unit_price_cents,
            quantity: it.quantity,
          }))}
        />
      )}

      <header className="text-center">
        {/* Header reflects the REAL state, not a blanket "Merci". A declined
            return is shown in red; a still-unpaid online order gets a neutral
            "finish your payment" prompt + the controls below; a settled order
            (paid, or pending-COD) keeps the celebratory confirmation. */}
        {paymentDeclined ? (
          <>
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-destructive/10 text-destructive">
              <AlertCircle className="h-7 w-7" strokeWidth={1.4} />
            </span>
            <h1 className="mt-6 font-serif text-3xl text-foreground sm:text-4xl">
              Paiement non abouti
            </h1>
            <p className="mt-3 font-body text-sm leading-relaxed text-muted-foreground/80">
              Votre paiement a été refusé ou annulé. Votre commande{" "}
              <strong className="font-medium text-foreground">{order.order_number}</strong> est
              réservée — vous pouvez réessayer le paiement ou l&apos;annuler ci-dessous.
            </p>
          </>
        ) : isPendingOnline ? (
          <>
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-olive/10 text-olive">
              <Clock className="h-7 w-7" strokeWidth={1.4} />
            </span>
            <h1 className="mt-6 font-serif text-3xl text-foreground sm:text-4xl">
              Finalisez votre paiement
            </h1>
            <p className="mt-3 font-body text-sm leading-relaxed text-muted-foreground/80">
              Votre commande{" "}
              <strong className="font-medium text-foreground">{order.order_number}</strong> est
              réservée mais le paiement n&apos;est pas encore confirmé. Terminez-le pour lancer le
              traitement.
            </p>
          </>
        ) : isClosed ? (
          <>
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-foreground/5 text-muted-foreground">
              <XCircle className="h-7 w-7" strokeWidth={1.4} />
            </span>
            <h1 className="mt-6 font-serif text-3xl text-foreground sm:text-4xl">
              {order.status === "refunded" ? "Commande remboursée" : "Commande annulée"}
            </h1>
            <p className="mt-3 font-body text-sm leading-relaxed text-muted-foreground/80">
              Votre commande{" "}
              <strong className="font-medium text-foreground">{order.order_number}</strong>{" "}
              {order.status === "refunded" ? "a été remboursée." : "a été annulée."}
            </p>
            {lateCapture && (
              <p className="mt-3 font-body text-xs text-destructive">
                Un paiement en ligne a toutefois été enregistré pour cette commande. Contactez-nous
                pour régulariser ce paiement.
              </p>
            )}
          </>
        ) : (
          <>
            <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-olive/10 text-olive">
              <CheckCircle2 className="h-7 w-7" strokeWidth={1.4} />
            </span>
            <p className="mt-7 font-body text-[0.6rem] uppercase tracking-[0.2em] text-muted-foreground/50">
              Commande {order.order_number} confirmée
            </p>
            <h1 className="mt-3 font-serif text-3xl text-foreground sm:text-4xl">
              Merci pour votre commande
            </h1>
            <p className="mt-4 font-serif text-lg text-foreground">{TND(order.total_cents)}</p>
            <p className="mt-3 font-body text-sm leading-relaxed text-muted-foreground/80">
              {/* Express orders can legitimately have no email (admin-configurable
                  field) — never render a dangling "envoyée à ." */}
              {order.contact_email ? (
                <>
                  Confirmation envoyée à{" "}
                  <strong className="font-medium text-foreground">{order.contact_email}</strong>.{" "}
                </>
              ) : null}
              Vous recevrez les mises à jour de suivi par email.
            </p>
          </>
        )}
        {/* Retry / cancel controls for a still-unpaid online order (owner or
            guest-UUID holder only). Amount-mismatch must NOT offer a naive
            retry — re-initiating can't fix a wrong amount. */}
        {isPendingOnline && canAct && (
          <PendingOnlineControls
            orderId={order.id}
            declined={paymentDeclined}
            allowRetry={!settleAmountMismatch}
          />
        )}
        {isPendingOnline && settleAmountMismatch && (
          <p className="mt-3 font-body text-xs text-destructive">
            Le montant réglé ne correspond pas à la commande. Contactez-nous pour
            régulariser ce paiement.
          </p>
        )}
      </header>

      <div className="mx-auto mt-10 max-w-2xl space-y-8">
        {/* Résumé — items + the SAME totals rules used across this app
            (admin order detail / invoice), so the confirmation never disagrees
            with the receipt. */}
        <section className="rounded-2xl border border-border/30 p-6 text-left md:p-8">
          <h2 className="mb-4 font-body text-[0.65rem] uppercase tracking-[0.2em] text-foreground/50">
            Résumé
          </h2>
          <div className="space-y-3 font-body text-sm">
            {items.map((it) => (
              <div key={it.id} className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground/70">
                  {it.product_name}
                  {it.variant_label ? ` — ${it.variant_label}` : ""} × {it.quantity}
                </span>
                <span className="shrink-0 tabular-nums text-foreground">
                  {TND(it.subtotal_cents)}
                </span>
              </div>
            ))}

            <div className="luxury-divider my-4" />

            <Row label="Sous-total" value={TND(order.subtotal_cents)} />
            {/* Always show the shipping line — "Offerte" beats silently omitting
                it (the customer should see they weren't charged). Pickup orders
                ship nothing, so the row is skipped there. */}
            {order.delivery_method === "home_delivery" && (
              <Row
                label="Livraison"
                value={order.shipping_cents > 0 ? TND(order.shipping_cents) : "Offerte"}
              />
            )}
            {order.delivery_method !== "home_delivery" && order.shipping_cents > 0 && (
              <Row label="Frais de retrait" value={TND(order.shipping_cents)} />
            )}
            {/* Tokyo Care protection add-on — a real charge contributing to the total. */}
            {order.care_cents > 0 && (
              <Row label="Tokyo Care (protection)" value={TND(order.care_cents)} />
            )}
            {order.discount_cents > 0 && (
              <Row label="Remise" value={`− ${TND(order.discount_cents)}`} tone="olive" />
            )}
            {/* "ht"-style added tax — a real line that contributes to the
                total. Hidden when the tax was inclusive (handled below). */}
            {effectiveTaxCents > 0 && !taxIncludedInTotal && (
              <Row
                label={`${taxLabel}${
                  orderTaxRates.length === 1
                    ? ` (${formatTaxRate(orderTaxRates[0])})`
                    : ""
                }`}
                value={TND(effectiveTaxCents)}
              />
            )}

            <div className="luxury-divider !my-4" />

            <div className="flex items-baseline justify-between">
              <span className="font-serif text-lg text-foreground">
                Total
                {effectiveTaxCents > 0 ? (
                  <span className="ml-1.5 font-body text-[0.65rem] uppercase tracking-[0.12em] text-muted-foreground/40">
                    TTC
                  </span>
                ) : null}
              </span>
              <span className="font-serif text-lg tabular-nums text-foreground">
                {TND(order.total_cents)}
              </span>
            </div>
            {/* Tax-inclusive ("ttc") — the tax is already inside the total, so
                it reads as a muted "dont TVA" note that doesn't change it. */}
            {effectiveTaxCents > 0 && taxIncludedInTotal && (
              <p className="pt-0.5 text-right font-body text-[0.6rem] tracking-wide text-muted-foreground/40">
                dont {taxLabel} {TND(effectiveTaxCents)}
              </p>
            )}
          </div>
        </section>

        {/* Prochaines étapes — static funnel of the post-checkout flow. Hidden
            for a still-unpaid online order (nothing has progressed yet — the
            header drives the "finish payment" prompt instead) and for a
            cancelled / refunded one (nothing further will happen). */}
        {!isPendingOnline && !isClosed && (
          <section className="rounded-2xl border border-border/30 p-6 text-left md:p-8">
            <div className="mb-6 flex items-center gap-3">
              <Package className="h-5 w-5 text-olive" strokeWidth={1.3} />
              <h2 className="font-body text-[0.65rem] uppercase tracking-[0.2em] text-foreground/50">
                Prochaines étapes
              </h2>
            </div>
            <div className="space-y-4">
              {[
                "Email de confirmation envoyé",
                "Préparation de votre commande",
                "Notification d'expédition avec suivi",
              ].map((step, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div
                    className={`grid h-6 w-6 place-items-center rounded-full font-body text-[0.55rem] ${
                      i === 0
                        ? "bg-olive text-background"
                        : "border border-border/50 text-muted-foreground/50"
                    }`}
                  >
                    {i + 1}
                  </div>
                  <span
                    className={`font-body text-sm ${
                      i === 0 ? "text-foreground" : "text-muted-foreground/60"
                    }`}
                  >
                    {step}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* QR card — the in-store retrieval code. */}
        {qrDataUrl && (
          <section className="rounded-2xl border border-border/30 p-6 text-center">
            <div className="flex flex-col items-center">
              <div className="mb-3 inline-block rounded-xl border border-border/20 bg-white p-2">
                {/* Plain <img>: this is an inline data URL, no need for the
                    next/image optimizer round-trip. */}
                <img src={qrDataUrl} alt="QR de la commande" className="h-24 w-24" />
              </div>
              <p className="mb-1 font-body text-[0.6rem] uppercase tracking-[0.15em] text-muted-foreground/50">
                QR Commande
              </p>
              <p className="font-body text-xs text-muted-foreground/50">
                Conservez ce code — présentez-le lors du retrait en boutique.
              </p>
            </div>
          </section>
        )}

        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          {/* "Suivre ma commande" → account tracking page. Only for the
              registered owner (a guest has no account view), and hidden while
              the online payment is still pending. */}
          {isRegisteredOwner && !isPendingOnline && (
            <Link
              href={`/account/orders/${order.id}`}
              className="btn-solid inline-flex h-12 items-center justify-center gap-2 rounded-xl px-8 text-xs"
            >
              Suivre ma commande
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.6} />
            </Link>
          )}
          {/* The « Reçu » download only appears once the order is actually placed —
              i.e. NOT while an online payment is still pending (nothing is confirmed or
              collected yet, so a receipt would be premature). A pending COD order is
              already confirmed (settles at delivery), so it keeps the receipt. A plain
              <a> (full document load), like the account order page: a soft <Link> into
              the tag-free (documents) group would keep the already-loaded GA/GTM runtime
              alive and report /facture/<uuid> as a history page_view. A registered
              order's receipt asks its owner to sign in (see /facture/[id]). */}
          {!isPendingOnline && (
            <a
              href={`/facture/${order.id}?autoprint=1`}
              className="btn-ghost-luxury inline-flex h-12 items-center justify-center gap-1.5 rounded-xl px-8 text-[0.65rem]"
            >
              <Download className="h-3.5 w-3.5" strokeWidth={1.6} />
              Télécharger PDF
            </a>
          )}
          <Link
            href="/"
            className="btn-ghost-luxury inline-flex h-12 items-center justify-center rounded-xl px-8 text-[0.65rem]"
          >
            Continuer mes achats
          </Link>
        </div>
      </div>
    </main>
  );
}

function Row({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  /** "olive" paints a discount/credit line in the luxury accent. */
  tone?: "olive";
}) {
  return (
    <div className={`flex items-center justify-between ${tone === "olive" ? "text-olive" : ""}`}>
      <span className={tone === "olive" ? "" : "text-muted-foreground/70"}>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
