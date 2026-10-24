import type { ReactNode } from "react";
import type { Viewport } from "next";

import { blogQueries } from "@/modules/blog";
import { getStorefrontShippingConfig } from "@/lib/checkout/shipping";
import { resolveCareConfig } from "@/lib/care/config";
import { getThemeConfig } from "@/lib/theme/config";
import { buildDarkModeInitJs } from "@/lib/theme/dark-mode-init";
import { getAllSettingsServerOnly, getSiteLogoUrl, listFooterColumns } from "@/lib/api/cms";
import { getSiteContacts, footerEntries } from "@/lib/cms/contact-list";
import { getFooterAppearance } from "@/lib/cms/footer-appearance";
import { resolveSocialList } from "@/lib/cms/social-list";
import { getCheckoutCopy, CHECKOUT_COPY_FALLBACKS } from "@/lib/checkout/copy";
import { getTrustBadgeAppearance } from "@/lib/cms/trust-badge-appearance";
import { trustBadgeService } from "@/modules/cms/trust_badge/service";
import { Footer, type FooterData } from "@/storefront/components/storefront/footer";
import { Header } from "@/storefront/components/storefront/header";
import { getTokyoHeaderNav } from "@/lib/api/tokyo-header-nav";
import { MobileBottomNav } from "@/storefront/components/storefront/mobile-bottom-nav";
import { TrustCopyProvider } from "@/components/storefront/trust-copy-provider";
import { ShippingConfigProvider } from "@/storefront/lib/shipping-config";
import { TaxModeProvider, type TaxDisplayMode } from "@/storefront/lib/tax-config";
import { CareConfigProvider } from "@/storefront/lib/care-config";
import { SiteContactsProvider, DEFAULT_CONTACTS } from "@/storefront/lib/site-contacts";

/**
 * New Tokyo storefront chrome — header + footer + mobile bottom nav — scoped
 * under `.tokyo` so it adopts the new crimson design system. The legacy
 * `(shell)` group keeps the backend chrome (`.storefront`) for every route the
 * new UI does not yet cover, so nothing is lost. Mirrors the Tokyo-Store-UI
 * `(shop)/(shell)/layout.tsx`.
 *
 * Reads the home-delivery shipping config (flat fee + free-shipping threshold)
 * from the backend's checkout settings ONCE here and seeds it through
 * `ShippingConfigProvider`, so every storefront surface (cart, checkout, home
 * promise, quick-buy) DISPLAYS the exact fee the order is CHARGED — correct in
 * the server render and for crawlers, not a client-side default. Same settings
 * read the root layout already does for SEO, so it stays statically generated.
 */
/**
 * The storefront's mobile browser-chrome tint = its beige canvas (--surface-beige),
 * so with viewportFit:cover the iOS/Android address-bar strips continue the canvas
 * the floating nav pill sits on, instead of the dark admin-primary the root sets.
 * Merges per-field over the root viewport (width/initialScale/viewportFit inherited).
 */
export const viewport: Viewport = { themeColor: "#f6f2ed" };

export default async function TokyoShellLayout({ children }: { children: ReactNode }) {
  // Backend-driven: shipping (seeded through the provider, like the root SEO read)
  // and the footer's identity + footer-flagged contacts, so the storefront chrome
  // reflects « Identité & contact » / the médiathèque logo — nothing hardcoded.
  const [shipping, settings, logoUrl, blogCategories, checkoutCopy, trustBadges, headerNav, theme, footerColumns, careConfig] =
    await Promise.all([
      getStorefrontShippingConfig(),
      getAllSettingsServerOnly().catch(() => ({}) as Record<string, string | null>),
      getSiteLogoUrl().catch(() => null),
      blogQueries.listAllCategories().catch(() => []),
      // Admin checkout copy (delivery ETA / warranty / returns labels) + the
      // admin-managed reassurance badges — so the PDP service band is fully backend-
      // driven (Contenu & Design → Badges de confiance + Système → Checkout), never
      // hardcoded. [] / fallbacks on failure → the band self-hides.
      getCheckoutCopy().catch(() => CHECKOUT_COPY_FALLBACKS),
      trustBadgeService.listActive().catch(() => []),
      getTokyoHeaderNav(),
      getThemeConfig().catch(() => null),
      // The footer's link columns (CMS → Footer menus). `undefined` on a READ
      // FAILURE → the footer falls back to its built-in columns so the chrome never
      // breaks on a DB hiccup. A successful EMPTY array is passed through as-is:
      // the system footer menus are seeded at boot + kept by the data clean, so an
      // empty read means the operator emptied them on purpose (honour it, don't
      // resurrect the defaults).
      listFooterColumns().catch(() => undefined),
      // Store-wide Tokyo Care charging knobs (per-unit / counts-toward-free-shipping),
      // seeded through the provider so the cart/checkout totals match place-order.
      // Fails closed internally; defaults here too on any error.
      resolveCareConfig().catch(() => ({ enabled: false, chargePerUnit: true, countsTowardFreeShipping: false })),
    ]);
  // Dark-mode pre-paint: resolve the `dark` class on <html> before first paint
  // from the admin « Mode sombre » setting (off ⇒ always light ⇒ no change) +
  // the visitor's saved choice. The `.tokyo` dark palette lives in globals.css
  // (`html.dark .tokyo`). Default "off" keeps the store byte-identical to today.
  const darkMode = theme?.darkMode ?? "off";
  const themeInitJs = buildDarkModeInitJs(darkMode);
  const contacts = getSiteContacts(settings);
  // TVA display mode (Système → TVA) — so the storefront only shows "TVA incluse"
  // when the store actually runs tax-inclusive, never in the default disabled mode.
  const rawTaxMode = settings["tax.mode"];
  const taxMode: TaxDisplayMode = rawTaxMode === "ttc" || rawTaxMode === "ht" ? rawTaxMode : "disabled";
  const footerData: FooterData = {
    brandName: settings["site.name"],
    tagline: settings["site.tagline"],
    logoUrl,
    phone: footerEntries(contacts.phones)[0]?.value ?? settings["site.contact_phone"],
    email: footerEntries(contacts.emails)[0]?.value ?? settings["site.contact_email"],
    hours: settings["site.hours"],
    stores: footerEntries(contacts.addresses).map((e) => e.value),
    // Central HQ / registered address — shown in the footer bottom bar only when
    // the admin enabled its front-end visibility (business.hq_address_public).
    hqAddress: settings["business.hq_address"],
    hqAddressPublic: settings["business.hq_address_public"] === "true",
    socials: resolveSocialList(settings),
    blogCategories: blogCategories.map((c) => ({ slug: c.slug, name: c.name })),
    // CMS → Footer: the editable link columns + the appearance toggles/social
    // style. Empty columns / default appearance ⇒ the footer renders its built-in
    // columns + today's look, so an unconfigured store stays pixel-identical.
    columns: footerColumns,
    appearance: getFooterAppearance(settings),
  };
  return (
    <ShippingConfigProvider value={shipping}>
     <TaxModeProvider value={taxMode}>
     <CareConfigProvider
       value={{
         chargePerUnit: careConfig.chargePerUnit,
         countsTowardFreeShipping: careConfig.countsTowardFreeShipping,
       }}
     >
      {/* Dark-mode pre-paint init — sets `dark` on <html> before paint so the
          `.tokyo` palette resolves without a flash. Validated enum → safe. */}
      {/* eslint-disable-next-line react/no-danger */}
      <script dangerouslySetInnerHTML={{ __html: themeInitJs }} />
      <SiteContactsProvider
        value={{
          phone: footerData.phone?.trim() || DEFAULT_CONTACTS.phone,
          email: footerData.email?.trim() || DEFAULT_CONTACTS.email,
        }}
      >
        <div className="tokyo flex min-h-dvh flex-col bg-surface-beige">
          <Header logoUrl={logoUrl} brandName={settings["site.name"]} nav={headerNav} />
          <main
            id="contenu"
            tabIndex={-1}
            className="flex-1 pb-14 focus:outline-none sm:pb-16 lg:pb-20"
          >
            <TrustCopyProvider
              value={{
                eta: checkoutCopy.etaLabel ?? "",
                warranty: checkoutCopy.warrantyLabel ?? "",
                returns: checkoutCopy.returnsLabel ?? "",
                badges: trustBadges.map((b) => ({
                  kind: b.kind,
                  label: b.label,
                  icon: b.icon,
                  visibility: b.visibility,
                })),
                config: getTrustBadgeAppearance(settings),
              }}
            >
              {children}
            </TrustCopyProvider>
          </main>
          <Footer data={footerData} />
          <MobileBottomNav />
        </div>
      </SiteContactsProvider>
     </CareConfigProvider>
     </TaxModeProvider>
    </ShippingConfigProvider>
  );
}
