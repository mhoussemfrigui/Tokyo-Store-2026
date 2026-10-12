"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { validateSiteSetting } from "@/workflows/cms/setting";
import { SITE_TEXT_FIELDS as TEXT_FIELDS } from "@/lib/cms/site-fields";
import { buildContactListSettings } from "@/lib/cms/contact-list-save";
import { buildSocialListSettings } from "@/lib/cms/social-list-save";

/**
 * Persist the storefront "Réglages site" settings — the identity, contact,
 * social and legal copy consumed by the header, footer, home page and help/legal
 * pages. requirePermission("settings_site","update") → validate ALL fields up
 * front (all-or-nothing) → one ATOMIC upsertSettingsBatch → revalidate the admin
 * page AND the storefront layout so the chrome reflects edits.
 *
 * The single-value field list lives in `@/lib/cms/site-fields` (a plain module)
 * so the Footer tab, which writes a subset of the same keys, imports the SAME
 * definitions. The multi-value contact lists (phones / emails / addresses) are
 * handled by buildContactListSettings — it writes each JSON array key plus its
 * legacy single PRIMARY key (first entry), shared with the Footer tab.
 */

export async function saveSiteSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("settings_site", "update");

  // Single-value fields: read + trim once, then validate ALL before writing.
  const entries = TEXT_FIELDS.map((f) => ({
    f,
    value: String(formData.get(f.key) ?? "").trim(),
  }));
  const fieldErrors: Record<string, string> = {};
  for (const { f, value } of entries) {
    const err = validateSiteSetting(f.key, value);
    if (err) fieldErrors[f.key] = err;
  }
  if (Object.keys(fieldErrors).length > 0) {
    const names = entries
      .filter(({ f }) => fieldErrors[f.key])
      .map(({ f }) => f.label)
      .join(", ");
    return {
      ok: false,
      error: "validation",
      message: `Champs invalides : ${names}. Aucune modification n'a été enregistrée.`,
      fieldErrors,
    };
  }

  // Multi-value contact lists (phones / emails / addresses) → array + primary keys.
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

  // HQ-address front-end visibility toggle. The <ToggleField> checkbox posts its
  // value only when checked (absent when off), so "present and not the literal
  // 'false'" is ON. Stored "true"/"false" like the footer toggles; the storefront
  // reads it as `=== "true"`.
  const hqPublicRaw = formData.get("business.hq_address_public");
  const hqAddressPublic = hqPublicRaw != null && hqPublicRaw !== "false" ? "true" : "false";

  const settings = [
    ...entries.map(({ f, value }) => ({ key: f.key, value, type: "text" as const, groupKey: f.group, label: f.label })),
    {
      key: "business.hq_address_public",
      value: hqAddressPublic,
      type: "text" as const,
      groupKey: "business",
      label: "Afficher le siège social sur le site",
    },
    ...contact.settings,
    ...social.settings,
  ];
  const res = await workflows.cms.upsertSettingsBatch({ settings }, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message, fieldErrors: res.fieldErrors };

  revalidatePath("/admin/cms/settings");
  revalidatePath("/", "layout");
  return { ok: true, message: "Réglages du site enregistrés." };
}
