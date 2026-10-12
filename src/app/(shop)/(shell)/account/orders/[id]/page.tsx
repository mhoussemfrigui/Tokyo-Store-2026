import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CreditCard, Download, FileText, MapPin, Package } from "lucide-react";

import {
  findOrderById,
  listItemsForOrder,
  listStatusHistory,
} from "@/modules/order/queries";
import {
  OrderSteps,
  OrderStatusTrail,
  customerTrailEvents,
} from "@/components/storefront/order-steps";
import { ORDER_STATUS_LABELS, isUpfrontPaidMethod, paymentMethodLabel } from "@/lib/order/status";
import { isOnlineMethod } from "@/lib/payments/shared";
import { orderTaxIncludedInTotal } from "@/lib/order/order-tax-mode";
import { formatMoneyExact } from "@/lib/price";
import { getActiveCurrency } from "@/lib/currency/active";
import { formatTaxRate, getTaxConfig } from "@/lib/tax";
import { generateOrderQrDataUrl } from "@/lib/qr/order-qr";
import { requireSession } from "@/lib/auth/session";
import { formatStoreDate } from "@/lib/time/store-tz";

/**
 * Customer order-detail / tracking page — the account-scoped view of a single
 * order. Owner-gated (registered customers only): the order must belong to the
 * signed-in user, or we 404. The public, UUID-accessible confirmation lives at
 * `/order/[id]`; this richer "Commande #…" tracking view sits under /account.
 *
 * Ports the design of tokyo-medusa's OrderDetail: back link, header with status
 * + payment badges and a "Télécharger PDF" link, the delivery timeline, an
 * Articles card with the exact confirmation-page totals breakdown, address +
 * info cards, and the order QR card. RSC, no framer-motion (tk-fade-in-up).
 */

export const metadata: Metadata = {
  title: "Suivi de commande",
  robots: { index: false, follow: false },
};

/** ISO country code → display name (orders are TN-only today). */
const COUNTRY_LABELS: Record<string, string> = { TN: "Tunisie" };

export default async function AccountOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Registered customers only — this is the account-scoped tracking page.
  const session = await requireSession({ from: `/account/orders/${id}` });

  const order = await findOrderById(id).catch(() => null);
  // Owner gate: a missing order OR one that isn't the viewer's → 404 (don't leak
  // the existence of someone else's order).
  if (!order || order.user_id !== session.user.id) notFound();

  const currency = await getActiveCurrency();
  const TND = (cents: number) =>
    formatMoneyExact(cents, currency.symbol, currency.symbolPosition);

  const [items, qrDataUrl, taxConfig, statusHistory] = await Promise.all([
    listItemsForOrder(order.id).catch(() => []),
    generateOrderQrDataUrl(order.id).catch(() => null),
    getTaxConfig().catch(() => null),
    listStatusHistory(order.id).catch(() => []),
  ]);

  // Real status changes only — an operator line edit's same-status audit row
  // stays on the admin timeline (it would repeat the current status here).
  const trailEvents = customerTrailEvents(statusHistory);

  // ── TVA display — COPIED from the confirmation page (src/app/(shop)/order/[id]/
  // page.tsx ~162-194) so the breakdown matches everywhere. The amount + rates
  // are SNAPSHOTS frozen at sale; we only read the current config for the label
  // and infer add-on ("ht") vs included ("ttc") from the order's own arithmetic.
  const taxLabel = taxConfig?.label || "TVA";
  const orderTaxRates = Array.from(
    new Set(
      items
        .map((it) => it.tax_rate_bps)
        .filter((b): b is number => b != null && b > 0),
    ),
  );
  const effectiveTaxCents = order.tax_manual_cents ?? order.tax_cents;
  const baseExclTax =
    order.subtotal_cents + order.shipping_cents + order.care_cents - order.discount_cents;
  const taxIncludedInTotal = orderTaxIncludedInTotal(order);

  const itemCount = items.reduce((s, i) => s + i.quantity, 0);
  const isHomeDelivery = order.delivery_method === "home_delivery";
  // The « Reçu » download appears once the order is actually placed — hidden while an
  // online payment is still pending (nothing confirmed/collected yet). A pending COD
  // order is already confirmed (settles at delivery), so it keeps the receipt.
  const isPendingOnline = order.status === "pending" && isOnlineMethod(order.payment_method);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      {/* Back to the orders list */}
      <Link
        href="/account"
        className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        ← Retour aux commandes
      </Link>

      {/* Header — title + date · status + payment badges. The PDF now lives in a
          « Documents » bar under the totals (clearly labelled), not a header link. */}
      <div className="tk-fade-in-up mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl md:text-3xl">Commande {order.order_number}</h1>
          {/* Store zone — created_at rendered store-local to match the printed
              reçu, not the server's UTC. */}
          <p className="mt-1 text-sm text-muted-foreground">
            {formatStoreDate(order.created_at, {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span className="rounded-full border border-olive/30 bg-olive/10 px-3 py-1 font-body text-[0.55rem] uppercase tracking-wider text-olive">
            {ORDER_STATUS_LABELS[order.status]}
          </span>
          <span className="rounded-full border border-border/50 px-3 py-1 font-body text-[0.55rem] uppercase tracking-wider text-muted-foreground">
            {paymentMethodLabel(order.payment_method)}
          </span>
        </div>
      </div>

      {/* Delivery timeline (+ dated trail). <OrderSteps> handles cancelled/
          refunded internally with a terminal notice. */}
      <section className="tk-fade-in-up space-y-4">
        <OrderSteps
          status={order.status}
          confirmed={order.confirmed_at != null}
          paidUpfront={isUpfrontPaidMethod(order.payment_method)}
          paid={order.paid_at != null}
        />
        {trailEvents.length > 0 && <OrderStatusTrail events={trailEvents} />}
      </section>

      {/* Wide layout — articles/totals (main) + a sidebar (adresse · informations · QR)
          on ≥lg, so the order detail fills the page width like the other account pages;
          the sidebar stacks under the articles on mobile. */}
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
      {/* Articles + totals */}
      <section className="tk-fade-in-up rounded-2xl border border-border/30 p-6 md:p-8">
        <h2 className="mb-6 text-[0.65rem] uppercase tracking-[0.2em] text-foreground/50">
          Articles
        </h2>
        <ul className="space-y-0">
          {items.map((it, idx) => (
            <li key={it.id}>
              {idx > 0 && <div className="luxury-divider" />}
              <div className="flex items-center gap-3.5 py-4">
                <span className="img-luxury relative grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-xl bg-accent/30">
                  {it.variant_image_url ?? it.product_image_url ? (
                    <img
                      src={it.variant_image_url ?? it.product_image_url ?? undefined}
                      alt=""
                      width={56}
                      height={56}
                      loading="lazy"
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <Package className="h-5 w-5 text-muted-foreground/40" strokeWidth={1.3} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-serif text-sm text-foreground">
                    {it.product_name}
                  </p>
                  {it.variant_label && (
                    <p className="mt-0.5 truncate font-body text-[0.6rem] uppercase tracking-[0.15em] text-muted-foreground/60">
                      {it.variant_label}
                    </p>
                  )}
                  {it.product_sku && (
                    <p className="mt-0.5 font-body text-[0.55rem] tracking-wide text-muted-foreground/40">
                      Réf. {it.product_sku}
                    </p>
                  )}
                  <p className="mt-1 font-body text-[0.7rem] tracking-wide text-muted-foreground/60">
                    Qté : {it.quantity} × {TND(it.unit_price_cents)}
                  </p>
                </div>
                <p className="shrink-0 font-serif text-sm tabular-nums text-foreground">
                  {TND(it.subtotal_cents)}
                </p>
              </div>
            </li>
          ))}
        </ul>

        <div className="luxury-divider my-6" />

        {/* Totals breakdown — mirrors the confirmation page's exact rules. */}
        <div className="space-y-3 font-body text-sm">
          <Row
            label={`Sous-total (${itemCount} article${itemCount !== 1 ? "s" : ""})`}
            value={TND(order.subtotal_cents)}
          />
          {/* « Remise », not « Code promo »: discount_cents is the coupon PLUS
              the member / business-tier discount (same label as /order/[id]). */}
          {order.discount_cents > 0 && (
            <Row label="Remise" value={`− ${TND(order.discount_cents)}`} tone="olive" />
          )}
          {/* Shipping line — "Gratuite" when free (home delivery only); a pickup
              order ships nothing, so its row is skipped (or shows a pickup fee). */}
          {isHomeDelivery && (
            <Row
              label="Livraison"
              value={order.shipping_cents > 0 ? TND(order.shipping_cents) : "Gratuite"}
            />
          )}
          {!isHomeDelivery && order.shipping_cents > 0 && (
            <Row label="Frais de retrait" value={TND(order.shipping_cents)} />
          )}
          {/* Tokyo Care protection add-on — a real charge contributing to the total. */}
          {order.care_cents > 0 && (
            <Row label="Tokyo Care (protection)" value={TND(order.care_cents)} />
          )}
          {/* "ht"-style added tax — a real line that contributes to the total. */}
          {effectiveTaxCents > 0 && !taxIncludedInTotal && (
            <Row
              label={`${taxLabel}${
                orderTaxRates.length === 1 ? ` (${formatTaxRate(orderTaxRates[0])})` : ""
              }`}
              value={TND(effectiveTaxCents)}
            />
          )}
          {/* Prix HT — the net base under an added tax. */}
          {effectiveTaxCents > 0 && !taxIncludedInTotal && (
            <Row label="Prix HT" value={TND(baseExclTax)} tone="muted" />
          )}
          <div className="luxury-divider !my-4" />
          <div className="flex items-baseline justify-between">
            <span className="font-serif text-lg text-foreground">
              Total
              {effectiveTaxCents > 0 ? (
                <span className="ml-1.5 font-body text-[0.55rem] text-muted-foreground/40">
                  TTC
                </span>
              ) : null}
            </span>
            <span className="font-serif text-lg tabular-nums text-foreground">
              {TND(order.total_cents)}
            </span>
          </div>
          {/* Tax-inclusive ("ttc") — a muted "dont TVA" note that doesn't change
              the total. */}
          {effectiveTaxCents > 0 && taxIncludedInTotal && (
            <p className="pt-0.5 text-right font-body text-[0.6rem] tracking-wide text-muted-foreground/40">
              dont {taxLabel} {TND(effectiveTaxCents)}
            </p>
          )}
        </div>

        {/* Documents — the downloadable PDF(s) for this order, in a labelled bar under
            the totals. Only once the order is placed (hidden while an online payment is
            still pending, like the receipt was). One document today (the Reçu); the list
            structure holds more if others become customer-facing. */}
        {!isPendingOnline && (
          <div className="mt-6 border-t border-border/40 pt-5">
            <p className="mb-3 text-[0.65rem] uppercase tracking-[0.2em] text-foreground/50">
              Documents
            </p>
            <a
              href={`/facture/${order.id}?autoprint=1`}
              className="flex items-center gap-3.5 rounded-2xl border border-border/40 p-3.5 transition-colors hover:border-foreground/30"
            >
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-muted/50 text-muted-foreground">
                <FileText className="h-5 w-5" strokeWidth={1.5} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">Reçu de commande</span>
                <span className="block text-xs leading-relaxed text-muted-foreground">
                  Récapitulatif détaillé (articles, remise, TVA, total) — PDF imprimable.
                </span>
              </span>
              <Download className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.6} />
            </a>
          </div>
        )}
      </section>

      {/* Sidebar — adresse · informations · QR (stacks under the articles on mobile). */}
      <div className="space-y-6">
      {/* Adresse de livraison — home delivery shows the address; a pickup order
          shows the method label instead. */}
      <section className="tk-fade-in-up rounded-2xl border border-border/30 p-6 md:p-8">
        <div className="mb-4 flex items-center gap-2">
          <MapPin className="h-4 w-4 text-olive" strokeWidth={1.4} />
          <h2 className="text-[0.65rem] uppercase tracking-[0.2em] text-foreground/50">
            Adresse de livraison
          </h2>
        </div>
        {isHomeDelivery ? (
          <div className="space-y-1 font-body text-sm">
            <p className="text-foreground">{order.ship_full_name}</p>
            <p className="text-muted-foreground/80">
              {order.ship_street_line1}
              {order.ship_street_line2 ? `, ${order.ship_street_line2}` : ""}
            </p>
            <p className="text-muted-foreground/80">
              {order.ship_postal_code ? `${order.ship_postal_code} ` : ""}
              {order.ship_city}
              {order.ship_region ? `, ${order.ship_region}` : ""}
            </p>
            <p className="text-muted-foreground/80">
              {COUNTRY_LABELS[order.ship_country] ?? order.ship_country}
            </p>
          </div>
        ) : (
          <div className="space-y-1 font-body text-sm">
            <p className="text-foreground">{order.ship_full_name}</p>
            {order.pickup_location_name && (
              <p className="text-muted-foreground/80">
                {order.pickup_location_name}
                {order.pickup_location_address ? ` — ${order.pickup_location_address}` : ""}
              </p>
            )}
          </div>
        )}
      </section>

      {/* Informations */}
      <section className="tk-fade-in-up rounded-2xl border border-border/30 p-6 md:p-8">
        <div className="mb-4 flex items-center gap-2">
          <CreditCard className="h-4 w-4 text-olive" strokeWidth={1.4} />
          <h2 className="text-[0.65rem] uppercase tracking-[0.2em] text-foreground/50">
            Informations
          </h2>
        </div>
        <div className="space-y-1 font-body text-sm text-muted-foreground/80">
          {order.contact_email && <p>Email : {order.contact_email}</p>}
          <p>Paiement : {paymentMethodLabel(order.payment_method)}</p>
          <p>Statut : {ORDER_STATUS_LABELS[order.status]}</p>
        </div>
      </section>

      {/* QR commande */}
      {qrDataUrl && (
        <section className="tk-fade-in-up space-y-4 rounded-2xl border border-border/30 p-6 md:p-8">
          <div className="shrink-0">
            <div className="rounded-xl border border-border/20 bg-white p-2.5">
              <img
                src={qrDataUrl}
                alt="QR de la commande"
                className="h-28 w-28"
                width={112}
                height={112}
              />
            </div>
          </div>
          <div className="min-w-0">
            <p className="mb-1.5 font-body text-[0.6rem] uppercase tracking-[0.15em] text-muted-foreground/50">
              QR Commande
            </p>
            <p className="mb-1 font-serif text-base text-foreground">{order.order_number}</p>
            <p className="font-body text-xs leading-relaxed text-muted-foreground/70">
              Scannez ce code pour vérifier cette commande ou présentez-le lors du retrait
              en boutique.
            </p>
          </div>
        </section>
      )}
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
  /** "olive" paints a discount/credit line in the luxury accent; "muted" dims it. */
  tone?: "olive" | "muted";
}) {
  return (
    <div
      className={`flex items-center justify-between ${
        tone === "olive" ? "text-olive" : ""
      }`}
    >
      <span
        className={
          tone === "olive"
            ? ""
            : tone === "muted"
              ? "text-muted-foreground/40"
              : "text-muted-foreground/70"
        }
      >
        {label}
      </span>
      <span className={`tabular-nums ${tone === "muted" ? "text-muted-foreground/50" : ""}`}>
        {value}
      </span>
    </div>
  );
}
