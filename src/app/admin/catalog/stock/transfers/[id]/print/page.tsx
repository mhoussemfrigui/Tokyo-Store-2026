import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { requirePermission } from "@/lib/auth/session";
import { isUuid } from "@/lib/utils/uuid";
import { formatStoreDate } from "@/lib/time/store-tz";
import { settingService } from "@/modules/cms/setting/service";
import { getSiteLogoDataUrl, getIssuerAddress } from "@/lib/api/cms";
import { stockLocationService } from "@/modules/stock-location";
import { stockTransferService } from "@/modules/stock-transfer";
import type { TransferStatus } from "@/modules/stock-transfer/schema";
import { TRANSFER_STATUS_META } from "@/modules/stock-transfer/status-meta";
import { PrintStyles } from "@/app/admin/orders/[id]/invoice/print-styles";

/**
 * Printable BON DE TRANSFERT — the internal logistics slip that travels with an
 * inter-location stock move so the receiving store can check the goods against
 * it. Price-free (a transfer carries no accounting value): the items + quantities,
 * the from/to locations, the transfer ref + status, and signature lines for the
 * three lifecycle hand-offs (préparé / expédié / reçu). Printing is driven by the
 * caller (the Transferts tab loads this into a hidden iframe and calls print), so
 * this page just renders. Never mutates. Under /admin (inherits the guard).
 */
export const metadata: Metadata = {
  title: { absolute: "Bon de transfert" },
  robots: { index: false, follow: false },
};

export default async function TransferSlipPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requirePermission("stock", "view");
  if (!isUuid(id)) notFound();

  const transfer = await stockTransferService.getById(id);
  if (!transfer) notFound();

  const [from, to, siteName, addressLine, legalName, logoDataUrl] = await Promise.all([
    stockLocationService.findById(transfer.from_location_id),
    stockLocationService.findById(transfer.to_location_id),
    settingService.findByKey("site.name"),
    // Issuer address = HQ (business.hq_address) with a fallback to the primary
    // store address.
    getIssuerAddress(),
    settingService.findByKey("business.legal_name"),
    // Inlined site logo (« Identité & contact ») — print-safe data URL, falls
    // back to the wordmark below when no logo is configured.
    getSiteLogoDataUrl(),
  ]);
  const shopName = siteName?.value ?? "Tokyo Store";

  const totalUnits = transfer.items.reduce((acc, it) => acc + it.qty, 0);
  const status = transfer.status as TransferStatus;

  return (
    <div
      className="mx-auto min-h-screen max-w-3xl bg-white p-8 text-black print:max-w-none print:p-[14mm]"
      style={
        {
          // Tokyo crimson document palette (matches the facture / bon de livraison +
          // emails): crimson accents, ink body text (`text-black` root), warm paper.
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
      {/* One A4 sheet: fix the page size (PrintStyles already zeroes the margin, so
          the 14mm wrapper padding is the only inset) and let the content flow on a
          single page for a typical transfer. */}
      <style>{"@media print{@page{size:A4}}"}</style>

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
        </div>
        <div className="text-right">
          <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[var(--bl-primary)]">
            Bon de transfert
          </p>
          <p className="mt-1 text-lg font-bold text-[var(--bl-primary)]">
            TR-{String(transfer.ref).padStart(6, "0")}
          </p>
          <p className="text-xs text-[var(--bl-muted)]">{formatStoreDate(transfer.created_at)}</p>
          <p className="mt-2 inline-flex rounded-full bg-[var(--bl-light)] px-2 py-0.5 text-[10px] font-semibold uppercase text-[var(--bl-primary)]">
            {TRANSFER_STATUS_META[status].label}
          </p>
        </div>
      </header>

      <section className="mt-6 grid grid-cols-2 gap-6 text-sm">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--bl-primary)]">
            Emplacement source
          </p>
          <p className="mt-1 font-medium">{from?.name ?? transfer.fromName ?? "—"}</p>
          {from?.code && <p className="text-xs text-[var(--bl-muted)]">Code : {from.code}</p>}
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--bl-primary)]">
            Emplacement destination
          </p>
          <p className="mt-1 font-medium">{to?.name ?? transfer.toName ?? "—"}</p>
          {to?.code && <p className="text-xs text-[var(--bl-muted)]">Code : {to.code}</p>}
        </div>
      </section>

      <table className="mt-6 w-full text-sm">
        <thead className="bg-[var(--bl-light)] text-left text-[10px] uppercase tracking-wider text-[var(--bl-primary)]">
          <tr>
            <th className="px-2 py-2">Article</th>
            <th className="px-2 py-2">SKU / Réf.</th>
            <th className="px-2 py-2 text-right">Qté</th>
            <th className="px-2 py-2 text-center print:w-16">Reçu</th>
          </tr>
        </thead>
        <tbody>
          {transfer.items.map((it) => (
            <tr key={it.id} className="border-b border-[var(--bl-border)] even:bg-[var(--bl-alt)]">
              <td className="px-2 py-3">
                <p className="font-medium">{it.productName}</p>
                {it.variantLabel && <p className="text-xs text-[var(--bl-muted)]">{it.variantLabel}</p>}
              </td>
              <td className="px-2 py-3 text-xs text-[var(--bl-muted)]">{it.productSlug}</td>
              <td className="px-2 py-3 text-right font-medium">{it.qty}</td>
              {/* Blank cell for the receiver to tick/count on paper. */}
              <td className="px-2 py-3" />
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-[var(--bl-primary)]">
          <tr>
            <td className="px-2 py-2 text-xs font-semibold text-[var(--bl-primary)]" colSpan={2}>
              Total unités
            </td>
            <td className="px-2 py-2 text-right text-sm font-bold text-[var(--bl-primary)]">
              {totalUnits}
            </td>
            <td />
          </tr>
        </tfoot>
      </table>

      {transfer.note && (
        <p className="mt-4 text-xs text-[var(--bl-muted)]">Note : {transfer.note}</p>
      )}

      <section className="mt-12 grid grid-cols-3 gap-6 text-sm">
        <div>
          <p className="border-t border-[var(--bl-border)] pt-2 text-xs text-[var(--bl-muted)]">
            Préparé par (nom + signature)
          </p>
        </div>
        <div>
          <p className="border-t border-[var(--bl-border)] pt-2 text-xs text-[var(--bl-muted)]">
            Expédié par (nom + signature)
          </p>
        </div>
        <div>
          <p className="border-t border-[var(--bl-border)] pt-2 text-xs text-[var(--bl-muted)]">
            Reçu par (nom + signature + date)
          </p>
        </div>
      </section>

      <footer className="mt-8 border-t border-[var(--bl-border)] pt-4 text-center text-[10px] text-[var(--bl-muted)]">
        Document interne sans valeur comptable — mouvement de stock entre emplacements.
      </footer>
    </div>
  );
}
