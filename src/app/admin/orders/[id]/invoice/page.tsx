import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DELIVERY_METHOD_LABELS } from "@/lib/checkout/delivery-method-labels";
import {
  findOrderById,
  listItemsForOrder,
} from "@/modules/order/queries";
import { orderService } from "@/modules/order/service";
import { settingService } from "@/modules/cms/setting/service";
import { getSiteLogoDataUrl, getIssuerAddress } from "@/lib/api/cms";
import { formatMoneyExact } from "@/lib/price";
import { getTaxConfig } from "@/lib/tax";
import { isUuid } from "@/lib/utils/uuid";
import { requirePermission } from "@/lib/auth/session";
import { generateOrderQrDataUrl } from "@/lib/qr/order-qr";
import { formatStoreDate } from "@/lib/time/store-tz";
import { documentShippingRow, documentShippingTaxCents, sumCareTaxCents } from "@/lib/order/document-money";
import { orderTaxIncludedInTotal } from "@/lib/order/order-tax-mode";
import { AutoPrint } from "./auto-print";
import { PrintStyles } from "./print-styles";
import { orderStatusLabel } from "@/lib/order/status";

/**
 * Printable invoice — minimal HTML, no admin chrome. Renders shop logo +
 * customer + items + totals. The `?autoprint=1` query param triggers
 * `window.print()` once the page mounts so admins can chain "Open invoice
 * → Print" with one click.
 *
 * Lives under /admin so it inherits the admin-only route guard from
 * src/app/admin/layout.tsx — no extra auth check needed here.
 */

// `title.absolute` bypasses the admin layout's `%s · Admin` template so the
// browser tab (and any residual print header) reads a clean "Facture"/"Avoir",
// not "Facture · Admin" on a customer-facing document.
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ doc?: string }>;
}): Promise<Metadata> {
  const { doc } = await searchParams;
  return {
    title: { absolute: doc === "avoir" ? "Avoir" : "Facture" },
    robots: { index: false, follow: false },
  };
}

type DocVariant = "invoice" | "avoir";

// Exact (3-decimal when fractional, i.e. millimes) — invoices are financial
// documents that must match the charged total exactly, not round to whole dinar.
// DELIBERATE (audit 2026-09-26): the fiscal facture always labels TND and ignores
// both `orders.currency` and the active display currency. The currency system is
// relabel-only (it never converts), so the stored millimes are always genuine
// TND — printing "TND" on a Tunisian legal document is the correct/compliant
// behavior, not a bug. Do NOT swap this for the display currency.
const formatTnd = (cents: number) => formatMoneyExact(cents);


export default async function InvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ autoprint?: string; doc?: string }>;
}) {
  const { id } = await params;
  const { autoprint, doc } = await searchParams;
  await requirePermission("orders", "view");
  if (!isUuid(id)) notFound();

  const order = await findOrderById(id);
  if (!order) notFound();

  const variant: DocVariant = doc === "avoir" ? "avoir" : "invoice";
  const isAvoir = variant === "avoir";

  const items = await listItemsForOrder(order.id);
  // Tokyo Care snapshot — its TVA is excluded from the shipping-tax remainder.
  const careItems = await orderService.listCareItems(order.id).catch(() => []);
  const careTaxCents = sumCareTaxCents(careItems);
  // Avoir (credit note) documents money returned. Once the avoir is ISSUED its
  // amount is frozen (credit_note_amount_cents, snapshotted under lock at
  // issuance) so a later refund can't change this numbered fiscal document; only
  // an un-issued preview (or a legacy avoir predating the column) falls back to
  // the live refund ledger.
  const refunds = isAvoir && order.credit_note_amount_cents == null ? await orderService.listRefunds(order.id) : [];
  const refundedCents = order.credit_note_amount_cents ?? refunds.reduce((acc, r) => acc + r.amount_cents, 0);

  // Doc header — fiscal number (when issued) + dated label per variant.
  const docLabel = isAvoir ? "Avoir" : "Facture";
  const docNumber = isAvoir
    ? order.credit_note_number ?? order.order_number
    : order.invoice_number ?? order.order_number;
  const docDate = isAvoir
    ? order.credit_note_at ?? order.created_at
    : order.invoiced_at ?? order.created_at;
  // Printed in the STORE zone — the fiscal number (fiscalYear) is store-local and
  // `docDate` (invoiced_at / created_at) must be rendered in the same zone, so a UTC
  // render would date a document issued between 00:00 and 01:00 Tunis the previous
  // day (the previous YEAR on 1 Jan).
  const docDateLabel = formatStoreDate(docDate);

  // Shop info from settings (best-effort — fallbacks keep the layout intact).
  // `business.legal_name` (raison sociale) + `business.tax_id` (matricule
  // fiscal) are the legal-identity fields the admin sets under "Informations
  // légales" — printed here so an invoice carries the legally-required issuer
  // identity (previously these settings had no reader at all).
  const [siteName, contactEmail, contactPhone, addressLine, legalName, taxId, taxConfig, qrDataUrl, logoDataUrl] =
    await Promise.all([
      settingService.findByKey("site.name"),
      settingService.findByKey("site.contact_email"),
      settingService.findByKey("site.contact_phone"),
      // Issuer address = HQ (business.hq_address) with a fallback to the primary
      // store address — a fiscal document carries the registered HQ, not a store.
      getIssuerAddress(),
      settingService.findByKey("business.legal_name"),
      settingService.findByKey("business.tax_id"),
      getTaxConfig(),
      generateOrderQrDataUrl(order.id, { width: 220 }).catch(() => null),
      // Inlined site logo (« Identité & contact ») — print-safe data URL, falls
      // back to the text shop name below when no logo is configured.
      getSiteLogoDataUrl(),
    ]);
  const shopName = siteName?.value ?? "Tokyo Store";

  // Invoice TVA — the per-order manual override wins over the computed snapshot.
  const effectiveTaxCents = order.tax_manual_cents ?? order.tax_cents;
  // A manual TVA (« TVA facture » control) is printed as such: the per-line
  // column stays the computed sale TVA, so it no longer sums to the total.
  const taxIsManual = order.tax_manual_cents != null;
  // Whether the tax was ADDED on top ("ht" → its own line in the total) or
  // already INCLUDED ("ttc" → an informational "dont TVA" note that does NOT
  // change the total). Inferred from the order's own arithmetic so the facture
  // reconciles in both modes (mirrors the customer confirmation page).
  const taxIncludedInTotal = orderTaxIncludedInTotal(order);

  // TVA rate (percent) for the totals label + item count for the sous-total line.
  const taxRatePct = taxConfig.defaultRateBps / 100;
  const itemCount = items.reduce((s, i) => s + i.quantity, 0);
  // TVA total label — the rate for a computed TVA, « (saisie) » for a manual one
  // (a hand-entered amount isn't necessarily that rate).
  const taxTotalLabel = taxIsManual
    ? `${taxConfig.label} (saisie)`
    : `${taxConfig.label} (${taxRatePct}%)`;
  // Shipping row (none on a free pickup) + the TVA its fee carries, so the
  // per-line TVA column + this term reconcile with the TVA total.
  const shippingRow = documentShippingRow(order.delivery_method, order.shipping_cents);
  const shippingTaxCents = shippingRow ? documentShippingTaxCents(order, items, careTaxCents) : 0;

  return (
    <div
      className="mx-auto min-h-screen max-w-3xl bg-white p-8 text-black print:max-w-none print:p-[14mm]"
      style={{ fontFamily: "var(--font-figtree), ui-sans-serif, system-ui, sans-serif" }}
    >
      <PrintStyles />
      {autoprint === "1" && <AutoPrint />}

      <header className="flex items-start justify-between gap-6 border-b border-[#e7e1da] pb-6">
        <div className="flex items-start gap-4">
          {qrDataUrl && (
            // Plain <img> data URL by design (printable artifact, no next/image).
            <img src={qrDataUrl} alt="QR commande" className="h-20 w-20 shrink-0" />
          )}
          <div>
            {logoDataUrl ? (
              // Plain <img> data URL by design (printable artifact, no next/image).
              <img
                src={logoDataUrl}
                alt={shopName}
                className="h-12 w-auto max-w-[220px] object-contain"
              />
            ) : (
              <h1
                className="text-2xl font-bold tracking-[0.12em] text-[#d40530]"
                style={{ fontFamily: "var(--font-outfit), var(--font-figtree), sans-serif" }}
              >
                {shopName}
              </h1>
            )}
            {legalName?.value && (
              <p className="text-xs font-medium text-gray-700">{legalName.value}</p>
            )}
            <p className="mt-1 text-xs text-gray-600">
              {addressLine ?? "Tunis, Tunisie"}
            </p>
            {contactEmail?.value && (
              <p className="text-xs text-gray-600">{contactEmail.value}</p>
            )}
            {contactPhone?.value && (
              <p className="text-xs text-gray-600">{contactPhone.value}</p>
            )}
            {taxId?.value && (
              <p className="text-xs text-gray-600">Matricule fiscal : {taxId.value}</p>
            )}
          </div>
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#d40530]">
            {docLabel}
          </p>
          <p className="mt-1 text-lg font-bold text-[#d40530]">{docNumber}</p>
          <p className="text-xs text-gray-600">{docDateLabel}</p>
          <p className="text-[10px] text-gray-500">Commande : {order.order_number}</p>
          {isAvoir && order.invoice_number && (
            <p className="text-[10px] text-gray-500">Facture : {order.invoice_number}</p>
          )}
          <p className="mt-2 inline-flex rounded-full bg-[#f6f2ed] px-2 py-0.5 text-[10px] font-semibold uppercase text-[#d40530]">
            {orderStatusLabel(order.status)}
          </p>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-6 text-sm">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#d40530]">
            Client
          </p>
          <p className="mt-1 font-medium">{order.ship_full_name}</p>
          <p className="text-xs text-gray-600">{order.contact_email}</p>
          {order.contact_phone && (
            <p className="text-xs text-gray-600">{order.contact_phone}</p>
          )}
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#d40530]">
            Livraison
          </p>
          {/* Delivery method + the agent / pickup-location snapshot frozen on
              the order at checkout. Agent/location lines print only when set. */}
          <p className="mt-1 text-xs font-medium">
            {DELIVERY_METHOD_LABELS[order.delivery_method] ?? order.delivery_method}
          </p>
          {order.delivery_agent_name && (
            <p className="text-xs text-gray-600">Livreur : {order.delivery_agent_name}</p>
          )}
          {order.pickup_location_name && (
            <p className="text-xs text-gray-600">
              {order.pickup_location_name}
              {order.pickup_location_address ? ` — ${order.pickup_location_address}` : ""}
            </p>
          )}
          <p className="mt-1 text-xs">
            {order.ship_street_line1}
            {order.ship_street_line2 ? `, ${order.ship_street_line2}` : ""}
            <br />
            {order.ship_postal_code ? `${order.ship_postal_code} ` : ""}
            {order.ship_city}
            {order.ship_region ? `, ${order.ship_region}` : ""}
            <br />
            {order.ship_country}
          </p>
        </div>
      </section>

      <table className="mt-6 w-full text-sm">
        <thead className="bg-[#f6f2ed] text-left text-[10px] uppercase tracking-wider text-[#d40530]">
          <tr>
            <th className="px-2 py-2 text-center">#</th>
            <th className="px-2 py-2">Article</th>
            <th className="px-2 py-2 text-right">Qté</th>
            <th className="px-2 py-2 text-right">Prix unit.</th>
            <th className="px-2 py-2 text-right">TVA{taxIsManual && !isAvoir ? "*" : ""}</th>
            <th className="px-2 py-2 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => (
            <tr key={it.id} className="border-b border-[#e7e1da] even:bg-[#fbf9f8]">
              <td className="px-2 py-3 text-center text-gray-500">{i + 1}</td>
              <td className="px-2 py-3">
                <p className="font-medium">{it.product_name}</p>
                {it.variant_label && (
                  <p className="text-xs text-gray-500">{it.variant_label}</p>
                )}
                {it.product_sku && (
                  <p className="text-xs text-gray-500">Réf. {it.product_sku}</p>
                )}
              </td>
              <td className="px-2 py-3 text-right">{it.quantity}</td>
              <td className="px-2 py-3 text-right">{formatTnd(it.unit_price_cents)}</td>
              <td className="px-2 py-3 text-right text-gray-600">
                {it.tax_cents > 0 ? formatTnd(it.tax_cents) : "—"}
              </td>
              <td className="px-2 py-3 text-right font-medium">
                {formatTnd(it.subtotal_cents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {taxIsManual && !isAvoir && (
        <p className="mt-2 text-[10px] text-gray-500">
          * {taxConfig.label} par ligne calculée à la vente — le total {taxConfig.label} de cette
          facture a été saisi manuellement.
        </p>
      )}

      <section className="mt-6 flex justify-end">
        <div className="w-72 space-y-2 rounded-lg bg-[#f6f2ed] p-4 text-sm">
          {isAvoir ? (
            <Row label="Total avoir (remboursé)" value={`− ${formatTnd(refundedCents)}`} bold />
          ) : (
            <>
              <Row label={`Sous-total (${itemCount} art.)`} value={formatTnd(order.subtotal_cents)} />
              {shippingRow && (
                <Row
                  label={shippingRow.label}
                  value={shippingRow.free ? "Gratuite" : formatTnd(order.shipping_cents)}
                />
              )}
              {shippingRow && shippingTaxCents > 0 && (
                <p className="text-right text-[11px] text-gray-600">
                  {taxConfig.label} sur {shippingRow.label.toLowerCase()} :{" "}
                  {formatTnd(shippingTaxCents)}
                </p>
              )}
              {order.care_cents > 0 && (
                <Row label="Tokyo Care (protection)" value={formatTnd(order.care_cents)} />
              )}
              {order.discount_cents > 0 && (
                <Row
                  label="Remise"
                  value={`− ${formatTnd(order.discount_cents)}`}
                  accent
                />
              )}
              {effectiveTaxCents > 0 && !taxIncludedInTotal && (
                <Row label={taxTotalLabel} value={formatTnd(effectiveTaxCents)} />
              )}
              <Row label="Total" value={formatTnd(order.total_cents)} bold />
              {effectiveTaxCents > 0 && taxIncludedInTotal && (
                <p className="pt-0.5 text-right text-[11px] text-gray-600">
                  dont {taxTotalLabel} {formatTnd(effectiveTaxCents)}
                </p>
              )}
            </>
          )}
        </div>
      </section>

      {order.payment_reference && (
        <p className="mt-6 text-xs text-gray-500">
          Référence paiement : {order.payment_reference}
        </p>
      )}

      <footer className="mt-12 border-t border-[#e7e1da] pt-4 text-center text-xs text-gray-500">
        <p>Merci de votre confiance.</p>
        <p className="mt-1 text-[10px] text-[#6b7280]">
          {shopName} — {docLabel} {docNumber} — {docDateLabel}
        </p>
      </footer>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  accent,
}: {
  label: string;
  value: string;
  bold?: boolean;
  accent?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between ${
        bold ? "mt-1 border-t-2 border-[#d40530] pt-2" : ""
      }`}
    >
      <span
        className={
          bold ? "font-semibold text-[#d40530]" : accent ? "text-[#d40530]" : "text-gray-600"
        }
      >
        {label}
      </span>
      <span
        className={
          bold ? "text-base font-bold text-[#d40530]" : accent ? "text-[#d40530]" : ""
        }
      >
        {value}
      </span>
    </div>
  );
}
