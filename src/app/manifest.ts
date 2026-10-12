import type { MetadataRoute } from "next";

import { getSeoConfig } from "@/lib/seo/config";
import { getThemeConfig, THEME_DEFAULTS } from "@/lib/theme/config";

/**
 * Web app manifest — generated from admin settings (site name/description, theme
 * color, favicon) rather than a static file, so rebranding needs no redeploy.
 * Next auto-serves this at /manifest.webmanifest and injects the <link>.
 */

// Without this the route is PRERENDERED at build (never time-revalidated): the
// Docker build has no DB, so getSeoConfig/getThemeConfig fall back to defaults
// and every deploy would serve the built-in name / colour / icon until some
// admin save busted the layout. force-dynamic = read the settings per request
// (one cached-per-request settings read), like sitemap.ts.
export const dynamic = "force-dynamic";
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const [seo, theme] = await Promise.all([
    getSeoConfig().catch(() => null),
    getThemeConfig().catch(() => null),
  ]);
  const name = seo?.siteName ?? "Tokyo Store";
  const icons: MetadataRoute.Manifest["icons"] = theme?.faviconUrl
    ? [{ src: theme.faviconUrl, sizes: "any" }]
    : [{ src: "/tokyo-logo.png", sizes: "any", type: "image/png" }];

  return {
    name,
    short_name: name,
    description: seo?.defaultDescription ?? undefined,
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: theme?.primaryColor ?? THEME_DEFAULTS.primaryColor,
    icons,
  };
}
