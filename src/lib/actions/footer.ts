"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { validateSiteSetting } from "@/workflows/cms/setting";
import {
  FOOTER_CONTENT_FIELDS,
  FOOTER_ENUM_FIELDS,
  FOOTER_BOOL_FIELDS,
  footerToggleValue,
} from "@/lib/cms/footer-fields";
import { buildContactListSettings } from "@/lib/cms/contact-list-save";
import { buildSocialListSettings } from "@/lib/cms/social-list-save";

/**
 * Save the FOOTER content + appearance from the Footer admin. Writes the SAME
 * `site.` / `social.` settings the footer reads (single source of truth — the
 * identity/contact/social values shared with the header, invoices and SEO) PLUS
 * the `storefront.footer.` appearance keys. It writes ONLY the footer-relevant
 * subset (FOOTER_CONTENT_FIELDS is built from SITE_TEXT_FIELDS by key), so it can
 * never blank non-footer identity keys (business., site.whatsapp) the way the full
 * « Réglages site » save would.
 *
 * Validate ALL fields first (all-or-nothing, no partial save) → write the whole
 * set through the ATOMIC batch workflow (one transaction) → revalidate the admin
 * + the storefront layout. The batch replaces the previous per-key loop, so a
 * mid-write DB failure can no longer leave the footer half-saved.
 */
export async function saveFooterAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("settings_site", "update");

  const content = FOOTER_CONTENT_FIELDS.map((f) => ({ f, value: String(formData.get(f.key) ?? "").trim() }));

  // Validate every content field up front (email/phone/map URL), name all
  // offenders, and write nothing on failure — no silent partial save. (The batch
  // workflow re-validates too; this gives per-field messages for the form.)
  const fieldErrors: Record<string, string> = {};
  for (const { f, value } of content) {
    const err = validateSiteSetting(f.key, value);
    if (err) fieldErrors[f.key] = err;
  }
  if (Object.keys(fieldErrors).length > 0) {
    const names = content.filter(({ f }) => fieldErrors[f.key]).map(({ f }) => f.label).join(", ");
    return {
      ok: false,
      error: "validation",
      message: `Champs invalides : ${names}. Aucune modification n'a été enregistrée.`,
      fieldErrors,
    };
  }

  // Multi-value contact lists (phones / emails / addresses) — same handling as
  // « Identité & contact » (array key + primary single), via the shared builder.
  const contact = buildContactListSettings(formData);
  if (!contact.ok) {
    // contact.message already ends with a period, so don't add another.
    return {
      ok: false,
      error: "validation",
      message: `Champs invalides : ${contact.message} Aucune modification n'a été enregistrée.`,
    };
  }

  // Multi-value social links (N per platform) → the `social.links` array key.
  const social = buildSocialListSettings(formData);
  if (!social.ok) {
    return {
      ok: false,
      error: "validation",
      message: `Champs invalides : ${social.message} Aucune modification n'a été enregistrée.`,
    };
  }

  // One atomic batch: content keys + contact lists + appearance enums (coerced to
  // the allow-list, defensive) + appearance toggles (unchecked checkbox → "false",
  // via the shared helper so it round-trips both ways).
  const settings = [
    ...content.map(({ f, value }) => ({ key: f.key, value, type: "text" as const, groupKey: f.group, label: f.label })),
    ...contact.settings,
    ...social.settings,
    ...FOOTER_ENUM_FIELDS.map((f) => {
      const raw = String(formData.get(f.key) ?? "").trim();
      return {
        key: f.key,
        value: f.allowed.includes(raw) ? raw : f.allowed[0],
        type: "text" as const,
        groupKey: "footer",
        label: f.label,
      };
    }),
    ...FOOTER_BOOL_FIELDS.map((f) => ({
      key: f.key,
      value: footerToggleValue(formData.get(f.key)),
      type: "text" as const,
      groupKey: "footer",
      label: f.label,
    })),
  ];

  const res = await workflows.cms.upsertSettingsBatch({ settings }, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message, fieldErrors: res.fieldErrors };

  revalidatePath("/admin/cms/footer");
  revalidatePath("/", "layout");
  return { ok: true, message: "Footer enregistré." };
}
