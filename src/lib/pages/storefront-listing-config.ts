import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { asStr } from "@/lib/cms/setting-coerce";

/**
 * Admin-controllable MARKETING copy shown on every listing surface (category,
 * brand and showcase pages) rendered through `CategoryPageClient`. Modeled on
 * `home-page-config.ts`: read namespaced `storefront.*` keys from
 * `site_settings`, return a plain object the client renders from.
 *
 * Currently this owns only the "Besoin d'un conseil" help CTA block — hidden in
 * full when its required copy is blank. (The in-grid promo/featured/newsletter
 * banners moved to real `category_grid` banners managed in CMS → Bannières;
 * they render between products via `CategoryGridBanner`.)
 */

export type StorefrontHelpCta = {
  /** Decorative kicker above the title. Hidden when empty. */
  eyebrow: string;
  /** Block headline. The whole block is hidden when this OR buttonLabel is empty. */
  title: string;
  /** Supporting paragraph. Hidden when empty. */
  body: string;
  /** Primary button label. Required for the block to render. */
  buttonLabel: string;
  /** Primary button href. Falls back to "#" only when the block is already shown. */
  buttonHref: string;
  /** Optional secondary button — both label AND href must be set to show it. */
  secondaryLabel: string;
  secondaryHref: string;
};

/** How the product grid paginates on every listing surface.
 *   - `load_more`  — a "Charger plus" button reveals the next page (DEFAULT);
 *   - `infinite`   — the next page auto-loads as the shopper nears the end;
 *   - `pagination` — classic numbered pages (one page shown at a time). */
export type ListingDisplayMode = "load_more" | "infinite" | "pagination";

export function asListingDisplayMode(v: string | null | undefined): ListingDisplayMode {
  return v === "infinite" || v === "pagination" ? v : "load_more";
}

export type StorefrontListingConfig = {
  helpCta: StorefrontHelpCta;
  /** Admin-chosen pagination behaviour for the product grid. */
  displayMode: ListingDisplayMode;
};

/** Empty config used when settings are unavailable — everything hides cleanly. */
export const STOREFRONT_LISTING_EMPTY: StorefrontListingConfig = {
  helpCta: {
    eyebrow: "",
    title: "",
    body: "",
    buttonLabel: "",
    buttonHref: "",
    secondaryLabel: "",
    secondaryHref: "",
  },
  displayMode: "load_more",
};

export async function getStorefrontListingConfig(): Promise<StorefrontListingConfig> {
  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    // settings table unavailable — empty config hides every optional block
    return STOREFRONT_LISTING_EMPTY;
  }
  const k = (key: string) => s[key];

  return {
    helpCta: {
      eyebrow: asStr(k("storefront.help_cta.eyebrow"), ""),
      title: asStr(k("storefront.help_cta.title"), ""),
      body: asStr(k("storefront.help_cta.body"), ""),
      buttonLabel: asStr(k("storefront.help_cta.button_label"), ""),
      buttonHref: asStr(k("storefront.help_cta.button_href"), ""),
      secondaryLabel: asStr(k("storefront.help_cta.secondary_label"), ""),
      secondaryHref: asStr(k("storefront.help_cta.secondary_href"), ""),
    },
    displayMode: asListingDisplayMode(k("storefront.listing_display_mode")),
  };
}
