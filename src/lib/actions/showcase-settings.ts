"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { COLLECTION_SLUGS, type CollectionSlug } from "@/lib/pages/collection-page-config";
import { type ActionState } from "@/lib/actions/types";

/**
 * Save the showcase collection pages (Nouveautés / Top ventes / Promotions).
 * Each page's content/selection/SEO fields are stored as `pages.<slug>.*`
 * site_settings (group `pages`), and manual pins go through the showcase
 * workflow. All pages submit together (FormTabs keeps panels mounted), so one
 * save persists everything. Only keys the panel actually renders belong in the
 * field lists below — a listed key with no input would be overwritten with NULL
 * on every save (the old `design_variant` did exactly that).
 */

type FieldType = "text" | "number" | "boolean" | "media";

const COMMON_FIELDS: { key: string; type: FieldType }[] = [
  { key: "visible", type: "boolean" },
  { key: "eyebrow", type: "text" },
  { key: "title", type: "text" },
  { key: "subtitle", type: "text" },
  { key: "cta_label", type: "text" },
  { key: "cta_href", type: "text" },
  { key: "hero_media_id", type: "media" },
  { key: "limit", type: "number" },
  { key: "default_sort", type: "text" },
  { key: "nav_bar", type: "text" },
  // Empty-state copy (rendered when the page has no products).
  { key: "empty_title", type: "text" },
  { key: "empty_body", type: "text" },
  // Closing CTA band (opt-in via show_closing_cta).
  { key: "show_closing_cta", type: "boolean" },
  { key: "cta_band_eyebrow", type: "text" },
  { key: "cta_band_title", type: "text" },
  { key: "cta_band_subtitle", type: "text" },
  { key: "cta_band_label", type: "text" },
  { key: "cta_band_href", type: "text" },
  { key: "meta_title", type: "text" },
  { key: "meta_description", type: "text" },
  { key: "noindex", type: "boolean" },
];

const EXTRA_FIELDS: Record<CollectionSlug, { key: string; type: FieldType }[]> = {
  nouveautes: [],
  "top-ventes": [{ key: "window_days", type: "number" }],
  promotions: [{ key: "promo_strategy", type: "text" }],
};

const LABEL: Record<CollectionSlug, string> = {
  nouveautes: "Nouveautés",
  "top-ventes": "Top ventes",
  promotions: "Promotions",
};

export async function saveShowcaseSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("showcase", "update");

  // Collect every pages.<slug>.* key across the three pages into ONE atomic batch
  // (mirrors footer/theme/site) so a mid-write DB failure can't leave the three
  // showcase pages half-configured. Pins (a different table/workflow) run only
  // after the settings batch succeeds.
  const settings = [];
  const pins: { slug: CollectionSlug; productIds: string[] }[] = [];
  for (const slug of COLLECTION_SLUGS) {
    const fields = [...COMMON_FIELDS, ...EXTRA_FIELDS[slug]];
    for (const field of fields) {
      const formKey = `pages.${slug}.${field.key}`;
      let value: string | null;
      if (field.type === "boolean") {
        value = formData.get(formKey) === "on" ? "true" : "false";
      } else {
        const raw = formData.get(formKey);
        value = raw === null ? null : String(raw).trim() || null;
      }
      settings.push({ key: formKey, value, type: field.type, groupKey: "pages", label: `${LABEL[slug]} — ${field.key}` });
    }
    // Manual pins — CSV of product ids from the picker's hidden input.
    const pinsRaw = String(formData.get(`pages.${slug}.pins`) ?? "").trim();
    pins.push({ slug, productIds: pinsRaw ? pinsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [] });
  }

  const res = await workflows.cms.upsertSettingsBatch({ settings }, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message, fieldErrors: res.fieldErrors };

  for (const p of pins) {
    const pr = await workflows.showcase.setPins(p, { actorUserId: session.user.id });
    if (!pr.ok) return { ok: false, error: pr.error, message: `Épingles ${LABEL[p.slug]} : ${pr.message}` };
  }

  for (const slug of COLLECTION_SLUGS) revalidatePath(`/${slug}`);
  revalidatePath("/", "layout");
  revalidatePath("/admin/cms/showcase");
  return { ok: true, message: "Vitrines enregistrées." };
}
