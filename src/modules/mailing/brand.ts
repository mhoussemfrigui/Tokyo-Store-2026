import "server-only";

import { getEmailLogoUrl } from "@/lib/api/cms";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { resolvePublicOrigin } from "@/lib/url/public-origin";
import { PLATFORM_LABELS, resolveSocialList } from "@/lib/cms/social-list";
import { safeHref } from "@/lib/utils/safe-href";
import { escapeHtml } from "./render";

/**
 * Settings-driven brand identity for transactional emails.
 *
 * Every email funnels through `wrap()` (see ./templates), whose header + footer
 * are now BRAND PLACEHOLDER tokens ({{ brand_logo }}, {{ brand_footer }},
 * {{ brand_socials }}, {{ brand_name }}, {{ brand_tagline }}) instead of
 * hardcoded constants. `dispatchEmail` / `renderEmailForPreview` resolve the
 * brand ONCE per send via `getEmailBrand()` and inject the rendered pieces from
 * `buildBrandVars()` as TRUSTED html (logo/footer/socials) + scalars (name /
 * tagline). The brand vars are never admin-authored — an admin override of a
 * template's subject/html still wins, but the layout's brand tokens are always
 * filled from these values.
 *
 * Fallbacks are the literals the templates used before this became
 * settings-driven, so a fresh site (no `site.*` / `social.*` settings) renders
 * exactly as it did — plus the logo once `site.logo_media_id` is set.
 */

/**
 * Fallback brand PRIMARY (Tokyo crimson) used when `theme.primary_color` is
 * unset — the storefront's THEME_DEFAULTS.primaryColor, so a fresh store's
 * emails match the live crimson site instead of a generic blue. Keep in sync
 * with src/lib/theme/config.ts THEME_DEFAULTS.
 */
export const BRAND_PRIMARY = "#d40530";
/** Fallback brand ACCENT (muted gold/taupe) when `theme.accent_color` is unset —
 *  = THEME_DEFAULTS.accentColor. */
export const BRAND_ACCENT = "#886E5C";

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const FALLBACK_NAME = "Tokyo Store";
const FALLBACK_TAGLINE = "Votre expert en produits technologiques de pointe";
const FALLBACK_ADDRESS = "Tunis, Tunisie";
const FALLBACK_CONTACT_EMAIL = "contact@tokyostore.tn";

export type EmailBrandSocial = { label: string; url: string };

export type EmailBrand = {
  name: string;
  tagline: string;
  /** Absolute URL to the logo, or null when no `site.logo_media_id` is set. */
  logoUrl: string | null;
  addressLine: string;
  contactEmail: string;
  /** Contact phone, or null when unset (hide-when-unset in the footer). */
  contactPhone: string | null;
  socials: EmailBrandSocial[];
  /** Brand colors — synced with the storefront theme (theme.*), fallbacks above. */
  primaryColor: string;
  accentColor: string;
};

/** Map a same-origin `/cdn/…` path to an absolute URL emails can load. `origin`
 *  is the resolved public origin (seo.site_url override aware) so a runtime domain
 *  change doesn't break the email logo <img>. */
function toAbsoluteUrl(url: string | null, origin: string): string | null {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  const base = origin.trim().replace(/\/+$/, "");
  if (!base) return null; // can't make it absolute → drop (avoid broken <img>)
  return url.startsWith("/") ? `${base}${url}` : `${base}/${url}`;
}

/**
 * Resolve the email brand from `site_settings` (read ONCE via getSettingsMap)
 * + the médiathèque logo. Never throws — on any failure it degrades to the
 * literal fallbacks so a transactional email always has a sane header/footer.
 */
export async function getEmailBrand(): Promise<EmailBrand> {
  let settings: Record<string, string | null> = {};
  let logoUrl: string | null = null;
  let origin = "";
  try {
    [settings, logoUrl, origin] = await Promise.all([
      getSettingsMap(),
      getEmailLogoUrl(),
      resolvePublicOrigin(),
    ]);
  } catch {
    settings = {};
    logoUrl = null;
    origin = "";
  }

  const get = (key: string) => settings[key]?.trim() || "";

  // Every link configured in « Identité & contact » (social.links — now many
  // per platform), in the admin's order, same source as the storefront footer +
  // SEO sameAs. Each row's own label (or the platform name) is the link text.
  const socials = resolveSocialList(settings)
    .map((link) => ({ label: link.label?.trim() || PLATFORM_LABELS[link.platform], url: safeHref(link.url) }))
    .filter((s) => s.url !== "#");

  // Brand colors follow the storefront theme so emails match the web — falling
  // back to the brand constants. Only strict hex is accepted (these land in
  // inline style attributes), mirroring getThemeConfig's validation.
  const hex = (key: string, fallback: string) => {
    const v = get(key);
    return HEX_RE.test(v) ? v : fallback;
  };

  return {
    name: get("site.name") || FALLBACK_NAME,
    tagline: get("site.tagline") || FALLBACK_TAGLINE,
    logoUrl: toAbsoluteUrl(logoUrl, origin),
    // Issuer address = central HQ (business.hq_address) when set, else the primary
    // store address — the registered address, not a retail store, on the footer line.
    addressLine: get("business.hq_address") || get("site.address") || FALLBACK_ADDRESS,
    contactEmail: get("site.contact_email") || FALLBACK_CONTACT_EMAIL,
    contactPhone: get("site.contact_phone") || null,
    socials,
    primaryColor: hex("theme.primary_color", BRAND_PRIMARY),
    accentColor: hex("theme.accent_color", BRAND_ACCENT),
  };
}

/** Rendered pieces the layout's brand tokens consume. */
export type EmailBrandVars = {
  /** Scalar — also used in the subject ("Bienvenue chez {{ brand_name }}"). */
  brand_name: string;
  /** Scalar tagline. */
  brand_tagline: string;
  /** HTML — an <img> logo when set, else the text wordmark + tagline block. */
  brand_logo: string;
  /** HTML — composed "Name · Address · email · phone" footer line. */
  brand_footer: string;
  /** HTML — inline row of social <a> links, or "" when none configured. */
  brand_socials: string;
  /** Validated hex — the storefront theme primary/accent, so email CTAs +
   *  eyebrows match the current site design (not a hardcoded orange). */
  brand_primary: string;
  brand_accent: string;
};

/**
 * Pure render of a resolved brand into the HTML/scalar pieces the email layout
 * needs. No I/O — callers pass the result of `getEmailBrand()`. Values are
 * escaped here because they originate from admin-entered settings; the produced
 * fragments are then injected as trusted html into the template body.
 */
export function buildBrandVars(brand: EmailBrand): EmailBrandVars {
  const name = escapeHtml(brand.name);
  const tagline = escapeHtml(brand.tagline);

  // Logo: an <img> (height-capped for email clients) when configured, else a bold
  // sans wordmark in the brand primary (crimson) + a muted tagline — the Tokyo
  // header before a logo is set. Email-safe web fonts only (no Figtree embed), so a
  // system sans stack that echoes the storefront's Figtree.
  const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
  const wordmark = `<div style="font-family:${SANS};font-weight:800;font-size:23px;letter-spacing:-0.015em;color:${brand.primaryColor};line-height:1.15;">${name}</div>
          <div style="font-family:${SANS};font-size:10px;text-transform:uppercase;letter-spacing:0.16em;color:#4b5563;margin-top:7px;">${tagline}</div>`;
  const brand_logo = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${name}" height="44" style="display:block;height:44px;width:auto;border:0;outline:none;text-decoration:none;margin:0 auto;">`
    : wordmark;

  // Footer line: "Name · Address · email · phone" — each segment hidden when
  // unset (only name is guaranteed).
  const footerParts = [
    name,
    escapeHtml(brand.addressLine),
    escapeHtml(brand.contactEmail),
    brand.contactPhone ? escapeHtml(brand.contactPhone) : "",
  ].filter(Boolean);
  const brand_footer = footerParts.join(" · ");

  // Socials: inline row of links, hidden entirely when none configured.
  const brand_socials =
    brand.socials.length > 0
      ? `<div style="margin:12px 0 0 0;font-size:11px;color:#4b5563;">` +
        brand.socials
          .map(
            (s) =>
              `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer nofollow" style="color:${brand.primaryColor};text-decoration:none;margin:0 6px;">${escapeHtml(s.label)}</a>`,
          )
          .join("·") +
        `</div>`
      : "";

  return {
    brand_name: brand.name,
    brand_tagline: brand.tagline,
    brand_logo,
    brand_footer,
    brand_socials,
    // Already strict-hex-validated in getEmailBrand → safe to inline into style attrs.
    brand_primary: brand.primaryColor,
    brand_accent: brand.accentColor,
  };
}
