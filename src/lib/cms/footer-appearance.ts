/**
 * Appearance / layout config for the storefront footer. Backed by
 * `storefront.footer.*` rows in `site_settings`, read with the shared coercers so
 * a hand-edited / unknown value can never select an invalid variant. Isomorphic +
 * client-safe (pure string logic over a settings map) so the shop layout (read)
 * and the Footer admin (edit) share ONE contract — mirroring trust-badge-appearance.
 *
 * The footer's CONTENT (brand/contact/socials, link columns, newsletter copy) is
 * the existing `site.*`/`social.*` settings + the footer-* nav menus + the
 * `footer`-placement banner; this module only governs HOW it looks/arranges.
 */
import { asBool, asEnum } from "@/lib/cms/setting-coerce";

/** Background tone of the onyx footer surface. */
export const FOOTER_TONES = ["onyx", "ink", "olive"] as const;
export type FooterTone = (typeof FOOTER_TONES)[number];

/** How the newsletter sign-up renders (its copy comes from the `footer` banner). */
export const FOOTER_NEWSLETTER_STYLES = ["banner", "card", "off"] as const;
export type FooterNewsletterStyle = (typeof FOOTER_NEWSLETTER_STYLES)[number];

/** Social icon treatment. */
export const FOOTER_SOCIAL_STYLES = ["circle", "square", "plain"] as const;
export type FooterSocialStyle = (typeof FOOTER_SOCIAL_STYLES)[number];

export type FooterAppearance = {
  tone: FooterTone;
  newsletterStyle: FooterNewsletterStyle;
  socialStyle: FooterSocialStyle;
  /** Show the brand blurb (site.description) under the wordmark. */
  showDescription: boolean;
  /** Show the contact rows (address / phone / email / hours). */
  showContact: boolean;
  /** Show the social icon row. */
  showSocials: boolean;
};

export const FOOTER_APPEARANCE_DEFAULTS: FooterAppearance = {
  tone: "onyx",
  newsletterStyle: "banner",
  socialStyle: "circle",
  showDescription: true,
  showContact: true,
  showSocials: true,
};

const KEY = (field: string) => `storefront.footer.${field}`;

/** Settings keys this config owns — the admin save writes exactly these. */
export const FOOTER_SETTING_KEYS = {
  tone: KEY("tone"),
  newsletterStyle: KEY("newsletter_style"),
  socialStyle: KEY("social_style"),
  showDescription: KEY("show_description"),
  showContact: KEY("show_contact"),
  showSocials: KEY("show_socials"),
} as const;

/** Resolve the footer appearance config from a loaded settings map. */
export function getFooterAppearance(settings: Record<string, string | null>): FooterAppearance {
  const d = FOOTER_APPEARANCE_DEFAULTS;
  return {
    tone: asEnum(settings[FOOTER_SETTING_KEYS.tone], FOOTER_TONES, d.tone),
    newsletterStyle: asEnum(settings[FOOTER_SETTING_KEYS.newsletterStyle], FOOTER_NEWSLETTER_STYLES, d.newsletterStyle),
    socialStyle: asEnum(settings[FOOTER_SETTING_KEYS.socialStyle], FOOTER_SOCIAL_STYLES, d.socialStyle),
    showDescription: asBool(settings[FOOTER_SETTING_KEYS.showDescription], d.showDescription),
    showContact: asBool(settings[FOOTER_SETTING_KEYS.showContact], d.showContact),
    showSocials: asBool(settings[FOOTER_SETTING_KEYS.showSocials], d.showSocials),
  };
}
