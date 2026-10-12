import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { findOrderById, listItemsForOrder } from "@/modules/order/queries";
import { orderService } from "@/modules/order/service";
import { settingService } from "@/modules/cms/setting/service";
import { getSiteLogoDataUrl, getIssuerAddress } from "@/lib/api/cms";
import { DELIVERY_METHOD_LABELS } from "@/lib/checkout/delivery-method-labels";
import { generateOrderQrDataUrl } from "@/lib/qr/order-qr";
import { isUuid } from "@/lib/utils/uuid";
import { requirePermission } from "@/lib/auth/session";
import { orderStatusLabel, paymentMethodLabel } from "@/lib/order/status";
import { formatStoreDate } from "@/lib/time/store-tz";
import { AutoPrint } from "../invoice/auto-print";
import { PrintStyles } from "../invoice/print-styles";

/**
 * Printable bon de livraison (delivery note). A PRICE-FREE logistics document:
 * the items + quantities being handed over, the shipping address, a scannable
 * order QR (→ /order/verify), and signature lines for preparer + recipient.
 * Renders EITHER the whole-order BL (orders.delivery_note_number, stamped via
 * issueDeliveryNoteAction on the Documents panel) OR, when `?shipment=<id>` is
 * passed, a single parcel's lines + its own gapless BL number (the partial-
 * shipment model: `shipments` / `shipment_items`, created from the Shipments
 * panel). The shipment id is validated to belong to this order. `?autoprint=1`
 * chains open → print. This route only renders; it never mutates.
 *
 * Under /admin so it inherits the admin route guard.
 */
// `title.absolute` bypasses the admin layout's `%s · Admin` template — see the
// invoice page for the rationale (clean title on a customer-facing document).
export const metadata: Metadata = {
  title: { absolute: "Bon de livraison" },
  robots: { index: false, follow: false },
};

export default async function DeliveryNotePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ autoprint?: string; shipment?: string }>;
}) {
  const { id } = await params;
  const { autoprint, shipment: shipmentId } = await searchParams;
  await requirePermission("orders", "view");
  if (!isUuid(id)) notFound();

  const order = await findOrderById(id);
  if (!order) notFound();

  // A specific parcel (?shipment=) renders only its lines + its own BL number;
  // otherwise the whole-order BL (orders.delivery_note_number) is rendered.
  const shipment =
    shipmentId && isUuid(shipmentId) ? await orderService.findShipmentById(shipmentId) : null;
  const validShipment = shipment && shipment.order_id === order.id ? shipment : null;

  const [items, shipmentLines, qrDataUrl, siteName, addressLine, legalName, taxId, logoDataUrl] = await Promise.all([
    listItemsForOrder(order.id),
    validShipment ? orderService.listShipmentItemsWithLines(validShipment.id) : Promise.resolve([]),
    generateOrderQrDataUrl(order.id, { width: 140 }).catch(() => null),
    settingService.findByKey("site.name"),
    // Issuer/sender address = HQ (business.hq_address) with a fallback to the
    // primary store address.
    getIssuerAddress(),
    settingService.findByKey("business.legal_name"),
    settingService.findByKey("business.tax_id"),
    // Inlined site logo (« Identité & contact ») — print-safe data URL, falls
    // back to the wordmark below when no logo is configured.
    getSiteLogoDataUrl(),
  ]);
  const shopName = siteName?.value ?? "Tokyo Store";

  // Normalised rows: a shipment renders its subset quantities; else all lines.
  const rows = validShipment
    ? shipmentLines.map((s) => ({
        name: s.line.product_name,
        variantLabel: s.line.variant_label,
        sku: s.line.variant_sku ?? s.line.product_sku ?? s.line.product_slug,
        qty: s.quantity,
      }))
    : items.map((it) => ({
        name: it.product_name,
        variantLabel: it.variant_label,
        sku: it.variant_sku ?? it.product_sku ?? it.product_slug,
        qty: it.quantity,
      }));
  const totalUnits = rows.reduce((acc, r) => acc + r.qty, 0);
  const blNumber = validShipment?.delivery_note_number ?? order.delivery_note_number;
  const blDate = validShipment?.shipped_at ?? validShipment?.delivery_note_at ?? order.delivery_note_at ?? order.created_at;
  const blAgent = validShipment?.delivery_agent_name ?? order.delivery_agent_name;
  const blMethod = validShipment?.delivery_method ?? order.delivery_method;
  const blTracking = validShipment?.tracking_ref ?? null;

  // Zero-pad a purely-numeric BL number to 6 digits (e.g. "42" → "000042"); a
  // non-numeric / fiscal-format number is left untouched, and the "— non émis —"
  // fallback is preserved for not-yet-stamped BLs.
  const blNumberDisplay = blNumber
    ? /^\d+$/.test(blNumber)
      ? blNumber.padStart(6, "0")
      : blNumber
    : "— non émis —";

  return (
    <div
      className="mx-auto min-h-screen max-w-3xl bg-white p-8 text-black print:max-w-none print:p-[14mm]"
      style={
        {
          // Tokyo crimson document palette (matches the facture / receipt + emails):
          // crimson accents, ink body text (`text-black` root), warm paper surfaces.
          "--bl-primary": "#d40530",
          "--bl-muted": "#6b7280",
          "--bl-light": "#f6f2ed",
          "--bl-border": "#e7e1da",
          "--bl-alt": "#fbf9f8",
          fontFamily: "var(--font-figtree), ui-sans-serif, system-ui, sans-serif",
        } as React.CSSProperties
      }
    >
      <PrintStyles />
      {autoprint === "1" && <AutoPrint />}

      <header className="flex items-start justify-between gap-6 border-b border-[var(--bl-border)] pb-6">
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
              className="text-2xl font-bold tracking-[0.18em] text-[var(--bl-primary)]"
              style={{ fontFamily: "var(--font-outfit), var(--font-figtree), sans-serif" }}
            >
              TOKYO
            </h1>
          )}
          <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-[var(--bl-muted)]">
            {shopName.toUpperCase()} · TUNISIA
          </p>
          {legalName?.value && (
            <p className="mt-1 text-xs font-medium text-[var(--bl-muted)]">{legalName.value}</p>
          )}
          <p className="text-xs text-[var(--bl-muted)]">{addressLine ?? "Tunis, Tunisie"}</p>
          {taxId?.value && (
            <p className="text-xs text-[var(--bl-muted)]">Matricule fiscal : {taxId.value}</p>
          )}
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bl-primary)]">
            Bon de livraison{validShipment ? " (partiel)" : ""}
          </p>
          <p className="mt-1 text-lg font-bold text-[var(--bl-primary)]">{blNumberDisplay}</p>
          <p className="text-[10px] text-[var(--bl-muted)]">Commande : {order.order_number}</p>
          {/* Store zone — the BL number (fiscalYear) is store-local; a UTC
              render would date a BL stamped 00:00-01:00 Tunis the day before. */}
          <p className="text-xs text-[var(--bl-muted)]">{formatStoreDate(blDate)}</p>
          {blTracking && <p className="text-[10px] text-[var(--bl-muted)]">Suivi : {blTracking}</p>}
          <p className="mt-2 inline-flex rounded-full bg-[var(--bl-light)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--bl-primary)]">
            {orderStatusLabel(order.status)}
          </p>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-[1fr_auto] gap-6">
        <div className="grid grid-cols-3 gap-6 text-sm">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--bl-primary)]">
              Expéditeur
            </p>
            <p className="mt-1 font-medium">{shopName}</p>
            {legalName?.value && (
              <p className="text-xs text-[var(--bl-muted)]">{legalName.value}</p>
            )}
            <p className="mt-1 text-xs text-[var(--bl-muted)]">
              {addressLine ?? "Tunis, Tunisie"}
            </p>
            {taxId?.value && (
              <p className="text-xs text-[var(--bl-muted)]">MF : {taxId.value}</p>
            )}
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--bl-primary)]">
              Destinataire
            </p>
            <p className="mt-1 font-medium">{order.ship_full_name}</p>
            {order.contact_phone && (
              <p className="text-xs text-[var(--bl-muted)]">{order.contact_phone}</p>
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
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--bl-primary)]">
              Livraison
            </p>
            <p className="mt-1 text-xs font-medium">
              {(blMethod && DELIVERY_METHOD_LABELS[blMethod]) ?? blMethod ?? order.delivery_method}
            </p>
            {blAgent && <p className="text-xs text-[var(--bl-muted)]">Livreur : {blAgent}</p>}
            {order.pickup_location_name && (
              <p className="text-xs text-[var(--bl-muted)]">
                {order.pickup_location_name}
                {order.pickup_location_address ? ` — ${order.pickup_location_address}` : ""}
              </p>
            )}
          </div>
        </div>
        {qrDataUrl && (
          // Plain <img> data URL by design (printable artifact, no next/image).
          <img src={qrDataUrl} alt="QR commande" className="h-28 w-28 shrink-0" />
        )}
      </section>

      <table className="mt-6 w-full text-sm">
        <thead className="bg-[var(--bl-light)] text-left text-[10px] uppercase tracking-wider text-[var(--bl-primary)]">
          <tr>
            <th className="px-2 py-2">Article</th>
            <th className="px-2 py-2">SKU / Réf.</th>
            <th className="px-2 py-2 text-right">Qté</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-[var(--bl-border)] even:bg-[var(--bl-alt)]">
              <td className="px-2 py-3">
                <p className="font-medium">{r.name}</p>
                {r.variantLabel && (
                  <p className="text-xs text-[var(--bl-muted)]">{r.variantLabel}</p>
                )}
              </td>
              <td className="px-2 py-3 text-xs text-[var(--bl-muted)]">{r.sku}</td>
              <td className="px-2 py-3 text-right font-medium">{r.qty}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-[var(--bl-primary)]">
          <tr>
            <td className="px-2 py-2 text-xs font-semibold text-[var(--bl-primary)]" colSpan={2}>
              Total colis / unités
            </td>
            <td className="px-2 py-2 text-right text-sm font-bold text-[var(--bl-primary)]">
              {totalUnits}
            </td>
          </tr>
        </tfoot>
      </table>

      {/* Payment band — price-free: states HOW the order settles (cash/card/COD)
          without ever printing an amount, so the BL stays "sans valeur comptable". */}
      <section className="mt-6 border-t-2 border-[var(--bl-primary)] pt-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--bl-primary)]">
          Moyen de paiement
        </p>
        <p className="mt-1 text-sm">{paymentMethodLabel(order.payment_method)}</p>
      </section>

      {order.notes && (
        <p className="mt-4 text-xs text-[var(--bl-muted)]">Note : {order.notes}</p>
      )}

      <section className="mt-12 grid grid-cols-2 gap-8 text-sm">
        <div>
          <p className="border-t border-[var(--bl-border)] pt-2 text-xs text-[var(--bl-muted)]">
            Préparé par (nom + signature)
          </p>
        </div>
        <div>
          <p className="border-t border-[var(--bl-border)] pt-2 text-xs text-[var(--bl-muted)]">
            Reçu par (nom + signature + date)
          </p>
        </div>
      </section>

      <footer className="mt-8 border-t border-[var(--bl-border)] pt-4 text-center text-[10px] text-[var(--bl-muted)]">
        Document sans valeur comptable — voir la facture pour les montants. Scannez le QR pour suivre la commande.
      </footer>
    </div>
  );
}
