import "server-only";

import {
  listHomeHeroSlides,
  listHeaderStripBanners,
  listFooterBanners,
  listMainMenu,
  listFooterColumns,
  listActiveTrustBadges,
  getSiteLogoUrl,
} from "./cms";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { getActiveCurrency, DEFAULT_CURRENCY, type ActiveCurrency } from "@/lib/currency/active";

/**
 * Headless content bundle — everything a head needs to render the site chrome
 * in one keyed read: hero/header/footer banners, header + footer navigation,
 * the logo, and the PUBLIC subset of site settings.
 *
 * ── SECURITY: never dump the raw settings map ─────────────────────────────
 * `site_settings` mixes public branding (site./theme./seo./checkout.…)
 * with SECRETS — payment gateway credentials (`payment.*`), mailing provider
 * creds + `mail.*_enc` ciphertext, auth config. `getSettingsMap()` returns
 * ALL rows, so exposing it verbatim would leak those secrets.
 *
 * Defence in depth: (1) an explicit ALLOW-list of public prefixes (these
 * values already ship in the public HTML — theme CSS vars, SEO meta, checkout
 * copy — so they are public by nature); (2) a secret-token DENY filter that
 * drops any key that still looks sensitive even under an allowed prefix.
 * `payment.` and `mail.` are NOT in the allow-list, so gateway keys / mail
 * secrets can never reach this surface.
 */
const PUBLIC_SETTING_PREFIXES = [
  "site.", // identity (name, contact, logo media id)
  "social.", // footer social-profile URLs (+ the public-wishlist toggle) — already in HTML
  "nav.", // header/footer navigation label overrides (renamed nav roots) — already in HTML
  "theme.", // design tokens (colors, radius, fonts, favicon) — already in HTML
  "seo.", // public SEO config (site url, OG media id, verification meta)
  "checkout.", // customer-facing copy (eta/returns/warranty labels)
  "shipping.", // public shipping config (base fee, free-ship threshold)
  "reviews.", // public review toggles
  "consent.", // consent banner copy (public)
  "tracking.", // tag ids + event/consent toggles (public by nature — ship in HTML)
];

const SECRET_TOKENS = ["_enc", "secret", "password", "token", "api_key", "apikey", "private"];

/**
 * Keys that match an allowed prefix but must NEVER reach the public bundle. The
 * custom-tracking snippets are raw, owner-trusted HTML/JS injected into the
 * storefront — exposing them as headless data would let a consumer double-inject
 * (and isn't theirs to render).
 */
const DENY_KEYS = new Set(["tracking.custom_head", "tracking.custom_body"]);

/** Curate the public-safe subset of settings (see security note above). */
function publicSettings(all: Record<string, string | null>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(all)) {
    if (!PUBLIC_SETTING_PREFIXES.some((p) => key.startsWith(p))) continue;
    if (DENY_KEYS.has(key)) continue;
    const lower = key.toLowerCase();
    if (SECRET_TOKENS.some((t) => lower.includes(t))) continue;
    out[key] = value;
  }
  return out;
}

export type ContentBundle = {
  banners: {
    hero: Awaited<ReturnType<typeof listHomeHeroSlides>>;
    header: Awaited<ReturnType<typeof listHeaderStripBanners>>;
    footer: Awaited<ReturnType<typeof listFooterBanners>>;
  };
  navigation: {
    main: Awaited<ReturnType<typeof listMainMenu>>;
    footerColumns: Awaited<ReturnType<typeof listFooterColumns>>;
  };
  /** Active global trust badges (buy-box reassurance strip). */
  trustBadges: Awaited<ReturnType<typeof listActiveTrustBadges>>;
  logoUrl: string | null;
  /** Active store currency (Commandes → Devises) — the headless analogue of the
   *  storefront MoneyProvider, so a head labels prices in the right currency. */
  currency: ActiveCurrency;
  settings: Record<string, string | null>;
};

export async function getContentBundle(): Promise<ContentBundle> {
  const [
    hero,
    header,
    footer,
    main,
    footerColumns,
    trustBadges,
    logoUrl,
    settingsAll,
    currency,
  ] = await Promise.all([
    listHomeHeroSlides().catch(() => []),
    listHeaderStripBanners().catch(() => []),
    listFooterBanners().catch(() => []),
    listMainMenu().catch(() => []),
    listFooterColumns().catch(() => []),
    listActiveTrustBadges().catch(() => []),
    getSiteLogoUrl().catch(() => null),
    getSettingsMap().catch(() => ({}) as Record<string, string | null>),
    getActiveCurrency().catch(() => DEFAULT_CURRENCY),
  ]);
  return {
    banners: { hero, header, footer },
    navigation: { main, footerColumns },
    trustBadges,
    logoUrl,
    currency,
    settings: publicSettings(settingsAll),
  };
}
