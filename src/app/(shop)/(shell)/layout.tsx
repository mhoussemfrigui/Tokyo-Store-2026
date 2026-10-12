import { cookies, headers } from "next/headers";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { BottomBarSpacer } from "@/components/storefront/bottom-bar";
import { MobileBottomBar } from "@/components/storefront/mobile-bottom-bar";
import { InkTrackProvider } from "@/components/storefront/ink-track-provider";
import { WishlistProvider } from "@/components/wishlist/wishlist-provider";
import { CartMergeOnLogin } from "@/components/cart/cart-merge-on-login";
import { ConsentProvider } from "@/components/consent/consent-provider";
import { CookieConsentBanner } from "@/components/consent/cookie-consent-banner";
import { TrackingScripts } from "@/components/tracking/tracking-scripts";
import { ConsentModeSync } from "@/components/tracking/consent-mode-sync";
import { PageLocationSync } from "@/components/tracking/page-location-sync";
import { CustomTrackingHtml } from "@/components/tracking/custom-tracking-html";
import { isTagFreePath } from "@/lib/tracking/redact-url";
import { SITE_PATH_HEADER } from "@/lib/site-mode/gate-exempt";
import { parseConsentConfig } from "@/lib/consent/config";
import {
  parseTrackingConfig,
  toClientTrackingConfig,
  clientTrackingFlags,
} from "@/lib/tracking/config";
import { buildConsentDefaultJs } from "@/lib/tracking/consent-mode";
import { listCategories } from "@/lib/api/categories";
import { resolveSearchConfig } from "@/modules/search/config";
import {
  listFooterBanners,
  listFooterColumns,
  listHeaderStripBanners,
  getAllSettingsServerOnly,
} from "@/lib/api/cms";
import { CART_COOKIE, readCart } from "@/lib/cart/session";
import { getCartSummary } from "@/modules/cart/queries";
import { mediaQueries } from "@/modules/media";
import { trustBadgeService } from "@/modules/cms/trust_badge/service";
import { getCheckoutCopy, CHECKOUT_COPY_FALLBACKS } from "@/lib/checkout/copy";
import { TrustCopyProvider } from "@/components/storefront/trust-copy-provider";
import { getTrustBadgeAppearance } from "@/lib/cms/trust-badge-appearance";
import { getFooterAppearance } from "@/lib/cms/footer-appearance";
import { getMainNavRoots } from "@/lib/api/main-nav-items";
import type { ResolvedNavRoot } from "@/lib/cms/nav-composer-model";
import { MoneyProvider } from "@/components/money-provider";
import { getPriceDecimals } from "@/lib/price-format";
import { getActiveCurrency, DEFAULT_CURRENCY } from "@/lib/currency/active";
import { getThemeConfig } from "@/lib/theme/config";
import { buildDarkModeInitJs } from "@/lib/theme/dark-mode-init";
import { getCurrentUser } from "@/lib/auth/session";
import {
  getSiteModeConfig,
  viewerCanBypassSiteGate,
} from "@/lib/site-mode/config";
import { isSiteGated } from "@/lib/site-mode/parse";
import { SiteGateNavGuard } from "@/components/site-gate-nav-guard";


/**
 * The storefront CHROME layer — nested one level below `(shop)/layout.tsx` so the
 * header/footer sit BELOW the 404 boundary and a storefront 404 can discard them
 * (see the sibling `(shop)/not-found.tsx` / `(shop)/layout.tsx`). Every route in
 * the group renders inside this shared chrome. The `admin` segment has its own
 * standalone layout (no header / footer) so this stays focused on the shop.
 *
 * Header + footer data is fetched once per request here and passed into the
 * client components so the mega menu, social links and contact info all
 * reflect what admins set. DB outages degrade gracefully —
 * every fetch falls back to an empty/neutral default so the chrome still
 * renders (hide-when-unset), never a crash or fabricated copy.
 */
export default async function ShopShellLayout({ children }: { children: React.ReactNode }) {
  // ── Maintenance / coming-soon : the EXEMPT bare shell ─────────────────────
  // The HARD gate lives one level UP in the thin `(shop)/layout.tsx` (above the
  // 404 boundary): it shows the full-page MaintenanceScene to every non-exempt
  // visitor AND to unknown-URL 404s, so a closed shop never leaks a branded 404.
  // Reaching here while the site is gated therefore means this IS an exempt route
  // — the session-less continuation pages (gate-exempt.ts): /login(/2fa),
  // /forgot-password + /reset-password (invite / reset links), /verify-email and
  // /se-desabonner (unsubscribe links in mail that keeps flowing). Render them in
  // a bare shell (no catalogue chrome) with a nav guard that hard-reloads any
  // navigation to a gated route (layouts don't re-run on client navigation).
  // Signed-in STAFF (bypass) fall through to the real chrome below. The mode read
  // is cache()'d, so re-checking it here (after the parent) is free. Fails OPEN.
  const siteMode = await getSiteModeConfig();
  if (isSiteGated(siteMode.mode) && !(await viewerCanBypassSiteGate())) {
    return (
      <div className="storefront flex min-h-dvh flex-col bg-background">
        <SiteGateNavGuard />
        <main className="flex-1">{children}</main>
      </div>
    );
  }

  const [
    categories,
    settings,
    footerColumns,
    headerStripBanners,
    footerBanners,
    cart,
    checkoutCopy,
    priceDecimals,
    theme,
    trustBadges,
    currency,
  ] = await Promise.all([
    listCategories().catch(() => []),
    getAllSettingsServerOnly().catch(() => ({}) as Record<string, string | null>),
    listFooterColumns().catch(() => []),
    listHeaderStripBanners().catch(() => []),
    listFooterBanners().catch(() => []),
    // Read-only — never writes the cart cookie (Next.js forbids cookie
    // mutation during layout render). Returns null when no cart exists
    // yet, which renders as 0 in the header badge.
    readCart()
      .then((c) => (c ? getCartSummary(c.id) : { itemCount: 0 }))
      .catch(() => ({ itemCount: 0 })),
    getCheckoutCopy().catch(() => CHECKOUT_COPY_FALLBACKS),
    getPriceDecimals().catch(() => 0),
    // DB-driven theme tokens → injected as CSS variables below. Null on failure
    // (the storefront then renders with the globals.css defaults).
    getThemeConfig().catch(() => null),
    // Buy-box reassurance badges (admin-managed). [] on failure → no strip.
    trustBadgeService.listActive().catch(() => []),
    // Active store currency (Commandes → Devises) — drives the price label.
    getActiveCurrency().catch(() => DEFAULT_CURRENCY),
  ]);
  // Guest-cart merge trigger: only mounted for a SIGNED-IN viewer who still
  // carries a guest cart cookie — the only case it can do anything. Mounted
  // unconditionally it fired a server-action POST (+ session lookup) on every
  // full page load of every visitor, anonymous ones and crawlers included.
  const currentUser = await getCurrentUser().catch(() => null);
  const needsGuestCartMerge = currentUser
    ? await cookies()
        .then((jar) => jar.has(CART_COOKIE))
        .catch(() => false)
    : false;

  // Consent config (banner copy, offered categories) derived from the settings
  // already fetched above — no extra DB round trip. The visitor's actual
  // decision lives in a cookie, read client-side by the provider.
  const consentConfig = parseConsentConfig(settings);

  // Tracking & Analytics config (admin Suivi & Analytics). Drives the tag
  // loader, the Consent-Mode-v2 default stub, and the funnel's per-event-group
  // gate (exposed to the client via window.__GZ_TRACK_CFG__).
  const trackingConfig = parseTrackingConfig(settings);
  const clientTracking = toClientTrackingConfig(trackingConfig);
  // « Bypass » (track everyone) OR a disabled cookie banner ⇒ no per-visitor
  // consent gate ⇒ the Consent Mode default starts GRANTED (and the provider
  // forces consent allowed). This is what reflects the banner state into Consent
  // Mode (issue #2) and powers the bypass switch (issue #4).
  const forceGranted = trackingConfig.bypassConsent || !consentConfig.enabled;
  // The Consent Mode default stub MUST run before GTM/GA loads; it's a raw inline
  // <script> (parse-time, before hydration). Emitted only when tracking is on AND
  // the strategy isn't "off" (off = no Consent Mode signalling at all).
  const consentDefaultJs =
    trackingConfig.enabled && trackingConfig.mode !== "off"
      ? buildConsentDefaultJs({
          defaults: trackingConfig.signalDefaults,
          forceGranted,
          regionEeaOnly: trackingConfig.regionEeaOnly,
          waitForUpdate: trackingConfig.waitForUpdate,
          adsDataRedaction: trackingConfig.adsDataRedaction,
          urlPassthrough: trackingConfig.urlPassthrough,
        })
      : null;
  // Per-event-group activation + Consent Mode strategy + bypass for the funnel.
  // JSON only (no interpolation of user strings), so injection-safe.
  const trackCfgJs = `window.__GZ_TRACK_CFG__=${JSON.stringify({
    groups: clientTrackingFlags(trackingConfig),
    mode: trackingConfig.mode,
    currency: currency.code,
    // gtag.js (direct GA4, no GTM) ignores the funnel's dataLayer ecommerce
    // objects, so the funnel re-emits events via gtag('event') in this mode —
    // without it a bare-GA4 install records page views only. See funnel.ts.
    ga4Direct: !!(trackingConfig.ga4Id && !trackingConfig.gtmId),
  })};`;
  // Owner custom snippets are injected by this layout, so the token-route
  // exclusion keys on the path the proxy stamped on the LATEST server render of
  // it — a full load, or a refresh() / revalidation (every cart mutation), NOT a
  // plain client navigation (layouts aren't re-rendered then). Landing on a token
  // route keeps them off until such a render happens on another path
  // (fail-private). TrackingScripts does the same per route via usePathname().
  const renderPath = await headers()
    .then((h) => h.get(SITE_PATH_HEADER))
    .catch(() => null);
  const customTagsAllowed = !isTagFreePath(renderPath);

  // Resolve the admin-configured logo (médiathèque) to a same-origin /cdn URL,
  // mirroring the SEO OG image. Unset/missing → null, so the header/footer fall
  // back to the bundled static asset (never a broken image).
  const logoMediaId = settings["site.logo_media_id"]?.trim() || null;
  const logoUrl = logoMediaId
    ? await mediaQueries.resolveUrlById(logoMediaId).catch(() => null)
    : null;

  // Composable mega-menu — the data-driven roots (CMS → Nav Menu), resolved from
  // the materialized `main` menu + the live catalog/média (falls back to the default
  // roots when un-seeded). getMainNavRoots builds its own catalog/credit deps and is
  // REQUEST-CACHED: the home page's SiteNavigationElement JSON-LD reads the same
  // cached roots, so the whole composition (média, product rails, dead-link pruning)
  // runs once per request, not once per caller.
  const navRoots: ResolvedNavRoot[] = await getMainNavRoots();

  // Dark-mode init: resolve the class before paint — admin "off" forces light
  // (even over a saved "dark": the toggle is hidden then), else the visitor's
  // saved choice → admin default → system preference. See buildDarkModeInitJs.
  const darkMode = theme?.darkMode ?? "off";
  const themeInitJs = buildDarkModeInitJs(darkMode);

  return (
    <ConsentProvider config={consentConfig} bypass={trackingConfig.bypassConsent}>
    <WishlistProvider>
    <MoneyProvider
      decimals={priceDecimals}
      currencySymbol={currency.symbol}
      currencyPosition={currency.symbolPosition}
    >
    {needsGuestCartMerge && <CartMergeOnLogin />}
    {/* Consent Mode v2 default stub — defines dataLayer/gtag + sets all signals
        denied (region-scoped) BEFORE any GTM/GA tag loads. Static/JSON values
        only → injection-safe. */}
    {consentDefaultJs && (
      /* eslint-disable-next-line react/no-danger */
      <script dangerouslySetInnerHTML={{ __html: consentDefaultJs }} />
    )}
    {/* Funnel activation flags + Consent Mode strategy, read by track(). */}
    {/* eslint-disable-next-line react/no-danger */}
    <script dangerouslySetInnerHTML={{ __html: trackCfgJs }} />
    {/* The DB-driven theme CSS variables (color / radius / font) are injected
        app-wide by the ROOT layout. Here we only add the storefront-only
        dark-mode pre-paint init (admin never renders this → stays light). */}
    {/* eslint-disable-next-line react/no-danger */}
    <script dangerouslySetInnerHTML={{ __html: themeInitJs }} />
    {/* min-h-dvh (not 100vh): on iOS the URL bar collapses on scroll, so 100vh
        over-reserves and leaves a dead gap at the bottom; the dynamic viewport
        unit tracks the real height. */}
    <div className="storefront flex min-h-dvh flex-col overflow-x-clip bg-background">
      <InkTrackProvider />
      {/* The header top strip shows the admin `header_strip` banners (CMS →
          Bannières) — the highest-priority active banner rotates through. */}
      <SiteHeader
        navRoots={navRoots}
        // Search-morph « recherches populaires » — the top categories, sourced
        // independently of the nav composition (so they show even if no nav root
        // has a categories block).
        searchSuggestions={categories.slice(0, 3).map((c) => ({ label: c.name, href: `/${c.slug}` }))}
        headerStripBanners={headerStripBanners}
        cartCount={cart.itemCount}
        logoUrl={logoUrl}
        // Mirror the footer's brand threading: admin-configured name + tagline
        // with the current literals as fallbacks (a fresh site looks identical).
        siteName={settings["site.name"]?.trim() || "Tokyo Store"}
        tagline={settings["site.tagline"]?.trim() || "Votre expert en produits technologiques de pointe"}
        // Min chars for the autocomplete dropdown — same admin knob the route /
        // page / service honour (resolved from the same cached settings map).
        searchMinQueryLength={resolveSearchConfig(settings).minQueryLength}
      />
      <main className="flex-1">
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
            // Strip appearance + per-surface placement (Badges de confiance →
            // Apparence). Read from the already-loaded settings map.
            config: getTrustBadgeAppearance(settings),
          }}
        >
          {children}
        </TrustCopyProvider>
      </main>
      {/* Newsletter now lives INSIDE the footer (a quiet inline row), driven by
          the admin-configured `footer`-placement banner. Null ⇒ no signup row. */}
      <SiteFooter
        settings={settings}
        columns={footerColumns}
        logoUrl={logoUrl}
        darkMode={darkMode}
        appearance={getFooterAppearance(settings)}
        newsletter={
          footerBanners[0]
            ? {
                eyebrow: footerBanners[0].eyebrow,
                title: footerBanners[0].title,
                subtitle: footerBanners[0].subtitle,
                cta: footerBanners[0].ctaLabel?.trim() || "S'inscrire",
              }
            : null
        }
      />
      {/* Reserves room for the mobile bottom nav pill, collapsing to 0 on the
          cart/checkout flow routes — see BottomBarSpacer. */}
      <BottomBarSpacer />
    </div>
    {/* Mobile bottom nav pill (Accueil · Favoris · Panier) — fills the strip the
        spacer reserves; the cart + wishlist icons are hidden from the mobile header. */}
    <MobileBottomBar cartCount={cart.itemCount} />
    </MoneyProvider>
    {/* Third-party tags (GTM/GA4/Pixel) + Consent Mode v2 sync + owner custom
        snippets, then the bottom consent banner. */}
    <TrackingScripts config={clientTracking} />
    <ConsentModeSync mode={trackingConfig.mode} hasPixel={!!trackingConfig.metaPixelId} />
    {/* Scrubs page_location (order UUIDs, tokens) on client navigations and
        sends the Meta PageView (skipped on bearer URLs) — see redact-url.ts. */}
    <PageLocationSync enabled={trackingConfig.enabled} />
    {/* Owner custom snippets run arbitrary third-party JS, so they MUST honor the
        master `tracking.enabled` kill-switch too (TrackingScripts already does).
        Otherwise flipping Suivi OFF would stop GTM/GA4/Pixel but leave a pasted
        Pixel/Hotjar snippet firing for any consenting visitor. Same for a render
        on a token route (reset / invite / join / unsubscribe link): a session
        recorder there would capture the live token. Gated on the `html` prop,
        NOT by unmounting: `customTagsAllowed` can flip across refresh()
        re-renders, and a remount would lose the `injected` guard and run the
        owner's snippet a second time in the same document. */}
    {trackingConfig.enabled && (
      <CustomTrackingHtml html={customTagsAllowed ? trackingConfig.customHead : ""} />
    )}
    {trackingConfig.enabled && (
      <CustomTrackingHtml html={customTagsAllowed ? trackingConfig.customBody : ""} />
    )}
    <CookieConsentBanner />
    </WishlistProvider>
    </ConsentProvider>
  );
}
