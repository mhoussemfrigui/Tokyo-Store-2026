import type { Metadata, Viewport } from "next";
import { Manrope, Figtree, Outfit } from "next/font/google";
import "./globals.css";
import { fontPlayfair, fontMontserrat, fontDmSans, fontJetBrainsMono } from "./fonts";

import { getSeoConfig, DEFAULT_SITE_NAME, DEFAULT_TITLE_TEMPLATE } from "@/lib/seo/config";
import { getThemeConfig, buildThemeCss } from "@/lib/theme/config";
import { getAdminThemeConfig, buildAdminThemeCss } from "@/lib/theme/admin-config";

// Manrope stays the ADMIN font; the storefront fonts (Playfair / Montserrat /
// DM Sans) are loaded here too and applied storefront-only via `.storefront`.
const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});

// Storefront (.tokyo) fonts: Figtree (body) + Outfit (display). Loaded app-wide
// on <html> and consumed only inside the `.tokyo` scope (see globals.css).
const figtree = Figtree({
  subsets: ["latin"],
  variable: "--font-figtree",
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
  weight: ["500", "600", "700", "800", "900"],
});

const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000").replace(/\/$/, "");

export async function generateMetadata(): Promise<Metadata> {
  const seo = await getSeoConfig().catch(() => null);
  const name = seo?.siteName ?? DEFAULT_SITE_NAME;
  const defaultTitle = seo?.defaultTitle ?? "Tokyo Store — iPhones, Smartphones, Gaming & High-Tech en Tunisie";
  const description =
    seo?.defaultDescription ??
    "Tokyo Store — iPhones, smartphones, gaming, accessoires et produits high-tech en Tunisie.";
  const base = seo?.siteUrl ?? siteUrl;
  // OG image: `getSeoConfig` already resolves the full fallback chain (explicit
  // SEO OG → theme default OG → site logo) to an absolute, social-safe URL, so
  // the layout just consumes it (no duplicate media re-resolution here).
  const theme = await getThemeConfig().catch(() => null);
  const ogImageUrl = seo?.ogImageResolvedUrl ?? seo?.ogImageUrl ?? null;
  const ogImages = ogImageUrl ? [ogImageUrl] : undefined;

  // Favicon = the médiathèque favicon (theme.favicon_media_id) when set. When it
  // is NOT set we leave `icons` unset so Next.js emits the purpose-built SQUARE
  // app icon (src/app/icon.svg) — the bundled brand logo (public/tokyo-logo.png)
  // is portrait, so pointing the tab/apple icon at it letterboxed a distorted
  // image into the square slot. Upload a square favicon (Thème → Favicon) to override.
  const faviconHref = theme?.faviconUrl ?? null;
  const icons = faviconHref ? { icon: faviconHref, shortcut: faviconHref, apple: faviconHref } : undefined;

  return {
    metadataBase: new URL(base),
    ...(icons ? { icons } : {}),
    title: { default: defaultTitle, template: seo?.titleTemplate ?? DEFAULT_TITLE_TEMPLATE },
    description,
    applicationName: name,
    generator: "Next.js",
    // `seo.knows_about` (Domaines d'expertise) and `seo.keywords` (Mots-clés du
    // site) are TWO distinct hub fields — UNION them (deduped) so filling one never
    // silently drops the other. `seo.keywords` itself defaults inside getSeoConfig.
    keywords: [
      ...new Set([
        ...(seo?.knowsAbout ?? []),
        ...(seo?.keywords ?? [
          "iPhone",
          "smartphone",
          "Apple",
          "gaming",
          "console",
          "high-tech",
          "accessoires",
          "Tunisie",
        ]),
      ]),
    ],
    openGraph: {
      title: defaultTitle,
      description,
      url: base,
      siteName: name,
      locale: "fr_TN",
      type: "website",
      ...(ogImages ? { images: ogImages } : {}),
    },
    twitter: {
      card: ogImages ? "summary_large_image" : "summary",
      title: defaultTitle,
      description,
      ...(seo?.twitterHandle ? { site: seo.twitterHandle } : {}),
      ...(ogImages ? { images: ogImages } : {}),
    },
    robots:
      seo && !seo.robotsIndex
        ? { index: false, follow: false }
        : {
            index: true,
            follow: true,
            googleBot: {
              index: true,
              follow: true,
              "max-image-preview": "large",
              "max-snippet": -1,
            },
          },
  };
}

export async function generateViewport(): Promise<Viewport> {
  // themeColor (the mobile browser chrome tint) follows the admin theme primary.
  const theme = await getThemeConfig().catch(() => null);
  return {
    themeColor: theme?.primaryColor ?? "#2B2825",
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // App-wide theme tokens (color / radius / font) so BOTH the storefront AND the
  // admin reflect the brand theme. Values are validated in getThemeConfig
  // (hex / clamp / allowlist) → injection-safe. The storefront-only dark mode
  // (palette + pre-paint script) lives in the (shop) layout; admin forces light.
  const [theme, adminTheme] = await Promise.all([
    getThemeConfig().catch(() => null),
    getAdminThemeConfig().catch(() => null),
  ]);
  const themeCss = theme ? buildThemeCss(theme) : null;
  // `.admin`-scoped — only affects the admin panel chrome; never the storefront.
  const adminThemeCss = adminTheme ? buildAdminThemeCss(adminTheme) : null;
  const fontVars = `${manrope.variable} ${fontPlayfair.variable} ${fontMontserrat.variable} ${fontDmSans.variable} ${figtree.variable} ${outfit.variable} ${fontJetBrainsMono.variable}`;
  return (
    <html lang="fr-TN" className={fontVars}>
      {/* suppressHydrationWarning: browser extensions (Grammarly, etc.) inject
          attributes like data-gr-ext-installed onto <body> before React
          hydrates, which is a benign server/client mismatch. This suppresses the
          warning for <body>'s OWN attributes only — real mismatches in children
          still surface. */}
      <body className="bg-background text-foreground" suppressHydrationWarning>
        {themeCss ? (
          // eslint-disable-next-line react/no-danger -- values validated in getThemeConfig
          <style dangerouslySetInnerHTML={{ __html: themeCss }} />
        ) : null}
        {adminThemeCss ? (
          // eslint-disable-next-line react/no-danger -- values validated in getAdminThemeConfig
          <style dangerouslySetInnerHTML={{ __html: adminThemeCss }} />
        ) : null}
        {children}
      </body>
    </html>
  );
}
