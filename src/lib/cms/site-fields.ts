/**
 * The `site.*` / `social.*` / `business.*` settings edited by the « Réglages
 * site » (Identité) form — the storefront identity, contact, social and legal
 * copy consumed by the header, footer, invoices and SEO.
 *
 * Extracted into a PLAIN module (not the `"use server"` action file, which may
 * only export async functions) so both the save action AND the Footer tab's field
 * list (which writes a SUBSET of the same keys) can import it and stay in lock-step
 * — one source of truth for each key's label + group, so the two tabs can't drift
 * and ping-pong `setting.upserted` audit rows for an unchanged value.
 */
export type SettingField = { key: string; label: string; group: string };

export const SITE_TEXT_FIELDS: readonly SettingField[] = [
  // Identité
  { key: "site.name", label: "Nom du site", group: "branding" },
  { key: "site.tagline", label: "Slogan", group: "branding" },
  { key: "site.description", label: "Description", group: "branding" },
  { key: "site.logo_media_id", label: "Logo du site (médiathèque)", group: "branding" },
  // NOTE: the top announcement strip moved to `header_strip` banners (CMS →
  // Bannières) — `site.announcement` is no longer written here.
  // Contact — SINGLE-value fields only. The multi-value lists (phones / emails /
  // addresses) live in site.contact_phones/_emails/addresses and are saved via
  // buildContactListSettings (contact-list-save.ts), NOT this plain-field loop.
  { key: "site.whatsapp", label: "WhatsApp", group: "contact" },
  { key: "site.hours", label: "Horaires d'ouverture", group: "contact" },
  // NOTE: the social links are NO LONGER fixed single keys here — they are an
  // ordered multi-value list (`social.links`, N per platform) saved via
  // buildSocialListSettings (social-list-save.ts), like the contact lists.
  // Informations légales / entreprise
  { key: "business.legal_name", label: "Raison sociale", group: "business" },
  { key: "business.tax_id", label: "Matricule fiscal / RNE", group: "business" },
  // Central HQ / registered address — the ISSUER address printed on fiscal
  // documents (facture / reçu / BL / transfert) and transactional emails, instead
  // of a retail store address. Shown on the storefront only when
  // `business.hq_address_public` is on (a separate toggle, not a text field, so it
  // is saved in saveSiteSettingsAction rather than this plain-text loop).
  { key: "business.hq_address", label: "Adresse du siège social", group: "business" },
];
