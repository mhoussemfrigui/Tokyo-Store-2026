import { formatMoneyExact } from "@/lib/price";
import type { TaxConfig } from "@/lib/tax";
import { orderStatusLabel } from "@/lib/order/status";
import { documentShippingRow, documentShippingTaxCents } from "@/lib/order/document-money";
import { orderTaxIncludedInTotal } from "@/lib/order/order-tax-mode";
import { formatStoreDate } from "@/lib/time/store-tz";
import type { OrderItemRow, OrderRow } from "@/modules/order/schema";

/**
 * Customer-facing receipt ("Reçu") — the same Tokyo-crimson facture visual the
 * admin invoice renders, extracted as a presentational server component so the
 * UUID-accessible customer facture page can reuse the exact layout WITHOUT
 * touching the admin page (which keeps its own copy intact, by task contract).
 *
 * Pure props in → JSX out. No DB, no auth, no jsPDF. The caller (the facture
 * page) loads the order/items/qr + the shop settings and tax config, gates
 * access, and passes everything here.
 *
 * Document label is "Reçu" (a fiscal Facture may not be issued yet) but the
 * structure mirrors the invoice exactly: QR top-left, crimson wordmark + fiscal
 * identity, Client/Livraison columns, the zebra item table, the warm-paper
 * rounded totals card with a crimson Total, and the "Merci de votre confiance."
 * footer. Typeset in the storefront's Figtree (loaded app-wide as
 * --font-figtree), with the wordmark in Outfit (--font-outfit).
 */

// Exact (3-decimal when fractional, i.e. millimes) — a receipt must match the
// charged total exactly, not round to whole dinar.
const formatTnd = (cents: number) => formatMoneyExact(cents);

/** Delivery-method labels (FR), keyed by the order's `delivery_method` column. */
const DELIVERY_METHOD_LABELS: Record<string, string> = {
  home_delivery: "Livraison à domicile",
  drive_by_pickup: "Drive",
  in_store: "Retrait en magasin",
};

export type ReceiptShopInfo = {
  siteName: string | null;
  /** Inlined site logo (« Identité & contact ») as a print-safe data URL, or
   *  null to fall back to the text shop name. */
  logoDataUrl: string | null;
  legalName: string | null;
  addressLine: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  taxId: string | null;
};

export function ReceiptDocument({
  order,
  items,
  qrDataUrl,
  taxConfig,
  shop,
  careTaxCents = 0,
}: {
  order: OrderRow;
  items: OrderItemRow[];
  qrDataUrl: string | null;
  taxConfig: TaxConfig;
  shop: ReceiptShopInfo;
  /** Σ order_care_items.tax_cents — so the Tokyo Care TVA is excluded from the
   *  shipping-tax remainder (tax_cents includes it). 0 for a care-free order. */
  careTaxCents?: number;
}) {
  const docLabel = "Reçu";
  // A fiscal invoice number may not be issued yet — the order number is the
  // stable customer-facing reference.
  const docNumber = order.order_number;
  // Printed in the STORE zone (Africa/Tunis) — created_at is the source of the
  // date (the order number no longer embeds one), so a UTC render would date a
  // late-night order the previous day.
  const docDateLabel = formatStoreDate(order.created_at);

  // Receipt TVA — the per-order manual override wins over the computed snapshot
  // (same expression as the admin invoice + customer confirmation page).
  const effectiveTaxCents = order.tax_manual_cents ?? order.tax_cents;
  // A manual TVA is printed as such: the per-line column stays the computed
  // sale TVA, so it no longer sums to the total (same rule as the facture).
  const taxIsManual = order.tax_manual_cents != null;
  // Whether the tax was ADDED on top ("ht" → its own line in the total) or
  // already INCLUDED ("ttc" → an informational "dont TVA" note that does NOT
  // change the total). Inferred from the order's own arithmetic so the receipt
  // reconciles in both modes (mirrors the customer confirmation page).
  const taxIncludedInTotal = orderTaxIncludedInTotal(order);

  // TVA rate (percent) for the totals label + item count for the sous-total line.
  const taxRatePct = taxConfig.defaultRateBps / 100;
  const itemCount = items.reduce((s, i) => s + i.quantity, 0);
  // TVA total label — the rate for a computed TVA, « (saisie) » for a manual one.
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
      <header className="flex items-start justify-between gap-6 border-b border-[#e7e1da] pb-6">
        <div className="flex items-start gap-4">
          {qrDataUrl && (
            // Plain <img> data URL by design (printable artifact, no next/image).
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qrDataUrl} alt="QR commande" className="h-20 w-20 shrink-0" />
          )}
          <div>
            {shop.logoDataUrl ? (
              // Plain <img> data URL by design (printable artifact, no next/image).
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={shop.logoDataUrl}
                alt={shop.siteName ?? "Tokyo Store"}
                className="h-12 w-auto max-w-[220px] object-contain"
              />
            ) : (
              <h1
                className="text-2xl font-bold tracking-[0.12em] text-[#d40530]"
                style={{ fontFamily: "var(--font-outfit), var(--font-figtree), sans-serif" }}
              >
                {shop.siteName ?? "Tokyo Store"}
              </h1>
            )}
            {shop.legalName && (
              <p className="text-xs font-medium text-gray-700">{shop.legalName}</p>
            )}
            <p className="mt-1 text-xs text-gray-600">{shop.addressLine ?? "Tunis, Tunisie"}</p>
            {shop.contactEmail && (
              <p className="text-xs text-gray-600">{shop.contactEmail}</p>
            )}
            {shop.contactPhone && (
              <p className="text-xs text-gray-600">{shop.contactPhone}</p>
            )}
            {shop.taxId && (
              <p className="text-xs text-gray-600">Matricule fiscal : {shop.taxId}</p>
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
            <th className="px-2 py-2 text-right">TVA{taxIsManual ? "*" : ""}</th>
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
      {taxIsManual && (
        <p className="mt-2 text-[10px] text-gray-500">
          * {taxConfig.label} par ligne calculée à la vente — le total {taxConfig.label} de ce
          reçu a été saisi manuellement.
        </p>
      )}

      <section className="mt-6 flex justify-end">
        <div className="w-72 space-y-2 rounded-lg bg-[#f6f2ed] p-4 text-sm">
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
            <Row label="Remise" value={`− ${formatTnd(order.discount_cents)}`} accent />
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
          {shop.siteName ?? "Tokyo Store"} — {docLabel} {docNumber} — {docDateLabel}
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
