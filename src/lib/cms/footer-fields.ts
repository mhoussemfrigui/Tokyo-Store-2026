/**
 * Field lists for the Footer tab's content + appearance save (saveFooterAction).
 *
 * PLAIN module (not the `"use server"` action file, which may only export async
 * functions) so a unit test can import these and pin the footer's data-safety
 * invariants:
 *   - CONTENT fields are a STRICT SUBSET of `SITE_TEXT_FIELDS`, built BY key from
 *     that one source — so the footer save can never blank a non-footer identity
 *     key (business.*, site.whatsapp) and its labels/groups can never drift from
 *     the « Réglages site » tab (no ping-pong `setting.upserted` audit churn).
 *   - ENUM / BOOL appearance keys all live under `storefront.footer.` — they can
 *     never reach a `site.*` key.
 */
import { SITE_TEXT_FIELDS, type SettingField } from "./site-fields";
import { FOOTER_SETTING_KEYS, FOOTER_SOCIAL_STYLES } from "./footer-appearance";

/**
 * The SINGLE-value subset of site./social. keys the footer renders. The
 * multi-value contact lists (phones / emails / addresses) are NOT here — the
 * footer save handles them via buildContactListSettings (contact-list-save.ts),
 * exactly like « Identité & contact ».
 */
const FOOTER_CONTENT_KEYS = [
  "site.name",
  "site.tagline",
  "site.description",
  "site.logo_media_id",
  "site.hours",
  // Social links moved to the `social.links` multi-value list (saved via
  // buildSocialListSettings, shared by both tabs) — no longer fixed single keys.
] as const;

const BY_KEY = new Map(SITE_TEXT_FIELDS.map((f) => [f.key, f]));

/** Content fields, resolved FROM SITE_TEXT_FIELDS so label + group stay in sync. */
export const FOOTER_CONTENT_FIELDS: readonly SettingField[] = FOOTER_CONTENT_KEYS.map((k) => {
  const field = BY_KEY.get(k);
  // Guards against a typo / a key removed from SITE_TEXT_FIELDS (fail at module
  // load, not with a silently-missing footer field).
  if (!field) throw new Error(`FOOTER_CONTENT_KEYS: "${k}" is not in SITE_TEXT_FIELDS`);
  return field;
});

/**
 * Enum appearance settings (value validated against its allow-list). Only the
 * controls the LIVE (tokyo) footer actually honours are editable: the social-icon
 * style. `tone` + `newsletter_style` were dropped — the crimson footer has a
 * fixed dark surface and no newsletter block, so they were no-ops on the live
 * store. getFooterAppearance still resolves them (at their defaults) for the
 * legacy `.storefront` footer.
 */
export const FOOTER_ENUM_FIELDS: Array<{ key: string; label: string; allowed: readonly string[] }> = [
  { key: FOOTER_SETTING_KEYS.socialStyle, label: "Style des réseaux", allowed: FOOTER_SOCIAL_STYLES },
];

/** Boolean appearance toggles (stored "true"/"false"). The live footer honours
 *  all three: the slogan line, the contact rows, and the social icons. */
export const FOOTER_BOOL_FIELDS: Array<{ key: string; label: string }> = [
  { key: FOOTER_SETTING_KEYS.showDescription, label: "Afficher le slogan" },
  { key: FOOTER_SETTING_KEYS.showContact, label: "Afficher les coordonnées" },
  { key: FOOTER_SETTING_KEYS.showSocials, label: "Afficher les réseaux" },
];

/**
 * An HTML checkbox submits its `value` only when checked; unchecked submits
 * nothing (→ null). Map that to the stored string: ONLY a literal "true" is ON,
 * everything else (null / "" / anything) is "false", so turning a toggle off
 * always persists "false" and sticks. Pure so the admin + a test can share it.
 */
export const footerToggleValue = (raw: FormDataEntryValue | null): "true" | "false" =>
  raw === "true" ? "true" : "false";
