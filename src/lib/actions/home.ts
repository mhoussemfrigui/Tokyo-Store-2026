"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { LISTING_SETTINGS } from "@/lib/pages/listing-settings-keys";

/**
 * Persist the LISTING-PAGE settings (the compact panel under the home composer):
 * the product-grid pagination mode + the « Besoin d'un conseil » help CTA that
 * render on every category / brand listing page. These are the only
 * live keys the old fixed-8-section home form still owned — the home layout itself
 * moved to the block composer (saveHomeBlocksAction → home.blocks), and the legacy
 * `home.*` keys are now just the non-destructive synthesis seed, edited by nothing.
 *
 * Kept on the home admin page for now (cross-links the listing surfaces); a future
 * Catalogues-tab pass can relocate them to the category settings.
 * Mirrors saveSiteSettingsAction: requirePermission → one ATOMIC upsertSettingsBatch.
 */
export async function saveHomeSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("home", "update");

  const settings = LISTING_SETTINGS.map((f) => ({
    key: f.key,
    value: String(formData.get(f.key) ?? "").trim(),
    type: "text" as const,
    groupKey: "home",
    label: f.label,
  }));
  const res = await workflows.cms.upsertSettingsBatch({ settings }, { actorUserId: session.user.id });
  if (!res.ok) return { ok: false, error: res.error, message: res.message };

  revalidatePath("/admin/cms/home");
  revalidatePath("/", "layout");
  return { ok: true, message: "Réglages des pages de liste enregistrés." };
}
