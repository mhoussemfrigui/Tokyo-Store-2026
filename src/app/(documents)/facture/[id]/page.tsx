import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { findOrderById, listItemsForOrder } from "@/modules/order/queries";
import { orderService } from "@/modules/order/service";
import { sumCareTaxCents } from "@/lib/order/document-money";
import { settingService } from "@/modules/cms/setting/service";
import { getSiteLogoDataUrl, getIssuerAddress } from "@/lib/api/cms";
import { getTaxConfig } from "@/lib/tax";
import { isUuid } from "@/lib/utils/uuid";
import { requireSession } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { generateOrderQrDataUrl } from "@/lib/qr/order-qr";
import { AutoPrint } from "@/app/admin/orders/[id]/invoice/auto-print";
import { PrintStyles } from "@/app/admin/orders/[id]/invoice/print-styles";
import { ReceiptDocument, type ReceiptShopInfo } from "./receipt-document";

/**
 * Customer-accessible printable receipt ("Reçu") — the same sage facture visual
 * the admin invoice renders, carrying the FULL customer PII (name, email, phone,
 * street address, line prices, payment reference). Access:
 *  - REGISTERED order (`user_id` set): its owner, or a staff session holding
 *    `orders:view` — like the owner-gated /account/orders/[id] that links here.
 *    Signed out ⇒ /login (back here after); anyone else ⇒ 404 (no existence leak).
 *  - GUEST order: anyone holding the order's UUID (no account to check), so a
 *    guest can print their receipt from the success page / e-mail. The UUID is a
 *    v7 — ~74 random bits (+ a ms creation timestamp): unguessable, but a BEARER
 *    capability that the order QR / e-mails / success URL also carry — never
 *    leak it (third-party tags get a scrubbed `/facture/:id`, redact-url.ts).
 *    A signed guest link / separate QR credential is a deferred owner decision.
 *
 * `?autoprint=1` triggers `window.print()` once the page mounts (reusing the
 * admin invoice's <AutoPrint> island), so a "Print receipt" link can chain
 * open → print in one click. HTML/SSR + window.print() only — NO jsPDF.
 */

// `title.absolute` keeps the browser tab (and any residual print header) reading
// a clean "Reçu", not the shop-layout template.
export const metadata: Metadata = {
  title: { absolute: "Reçu" },
  robots: { index: false, follow: false },
};

export default async function CustomerReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ autoprint?: string }>;
}) {
  const { id } = await params;
  const { autoprint } = await searchParams;
  // Reject a malformed id before the DB `::uuid` cast.
  if (!isUuid(id)) notFound();

  const order = await findOrderById(id).catch(() => null);
  if (!order) notFound();

  // Registered order ⇒ owner or `orders:view` staff only (see the header). A
  // guest order keeps the UUID-bearer model. requireSession redirects a signed-
  // out (or disabled) viewer to /login with `from` pointing back here.
  if (order.user_id) {
    const from = `/facture/${id}${autoprint === "1" ? "?autoprint=1" : ""}`;
    const session = await requireSession({ from });
    if (session.user.id !== order.user_id) {
      const perms = await resolveUserPermissions(session.user.id).catch(() => new Set<string>());
      if (!permissionSetAllows(perms, "orders", "view")) notFound();
    }
  }

  // Shop legal identity (best-effort — fallbacks keep the layout intact) + items
  // + QR + tax config, all independent → one parallel batch.
  const [
    items,
    qrDataUrl,
    taxConfig,
    siteName,
    legalName,
    addressLine,
    contactEmail,
    contactPhone,
    taxId,
    logoDataUrl,
    careItems,
  ] = await Promise.all([
    listItemsForOrder(order.id).catch(() => []),
    generateOrderQrDataUrl(order.id, { width: 220 }).catch(() => null),
    getTaxConfig().catch(() => null),
    settingService.findByKey("site.name").catch(() => null),
    settingService.findByKey("business.legal_name").catch(() => null),
    // Issuer address = HQ (business.hq_address) with a fallback to the primary
    // store address — NOT a per-store address on a fiscal document.
    getIssuerAddress().catch(() => null),
    settingService.findByKey("site.contact_email").catch(() => null),
    settingService.findByKey("site.contact_phone").catch(() => null),
    settingService.findByKey("business.tax_id").catch(() => null),
    // Inlined site logo (« Identité & contact ») — print-safe data URL; the
    // receipt falls back to the text shop name when no logo is configured.
    getSiteLogoDataUrl().catch(() => null),
    // Tokyo Care snapshot — its TVA is excluded from the shipping-tax remainder.
    orderService.listCareItems(order.id).catch(() => []),
  ]);
  const careTaxCents = sumCareTaxCents(careItems);

  const shop: ReceiptShopInfo = {
    siteName: siteName?.value ?? null,
    logoDataUrl,
    legalName: legalName?.value ?? null,
    addressLine: addressLine ?? null,
    contactEmail: contactEmail?.value ?? null,
    contactPhone: contactPhone?.value ?? null,
    taxId: taxId?.value ?? null,
  };

  // Tax config never throws (getTaxConfig degrades to the disabled default), but
  // guard the `.catch(() => null)` above with the same disabled fallback so the
  // receipt always renders.
  const resolvedTax = taxConfig ?? {
    mode: "disabled" as const,
    defaultRateBps: 1900,
    label: "TVA",
    onShipping: false,
  };

  return (
    <>
      <PrintStyles />
      {/* Print-isolation: the (documents) group INTENTIONALLY has no layout of
          its own — no storefront chrome and no third-party tags (this page is
          the full-PII receipt; never move it back under (shop)). The printed /
          saved-PDF receipt must be the document ALONE, so as belt-and-braces the
          visibility trick hides everything, re-shows only the receipt subtree,
          and lifts it to the top — independent of whatever the root layout adds.
          Scoped to #facture-print so the shared <PrintStyles> stays untouched. */}
      <style
        dangerouslySetInnerHTML={{
          __html:
            "@media print{body{visibility:hidden}#facture-print,#facture-print *{visibility:visible}#facture-print{position:absolute;left:0;top:0;width:100%}}",
        }}
      />
      {autoprint === "1" && <AutoPrint />}
      <div id="facture-print">
        <ReceiptDocument
          order={order}
          items={items}
          qrDataUrl={qrDataUrl}
          taxConfig={resolvedTax}
          shop={shop}
          careTaxCents={careTaxCents}
        />
      </div>
    </>
  );
}
