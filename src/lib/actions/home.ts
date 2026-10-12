"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { parseHomeBlocks, serializeHomeBlocks } from "@/lib/pages/home-blocks";
import { parseJsonArrayField } from "@/lib/pages/boutique-landing-parse";
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

/**
 * Persist the HOME BLOCK COMPOSER layout — the ordered block-instance array the admin
 * composer posts as a JSON blob in `blocks`. Re-validated + cleaned server-side through
 * parseHomeBlocks (unknown types dropped, every config field coerced through the
 * médiathèque/safe-href/enum guards, stable ids, 40-block cap) before it is stored under
 * `home.blocks`, so a crafted payload can never persist bad data. Once saved, this list
 * drives the storefront home (the legacy `home.*` keys become dormant).
 */
export async function saveHomeBlocksAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("home", "update");
  // Reject a PRESENT-but-unparseable payload (truncated POST / tampered request) instead of
  // silently storing []: getHomeBlocks treats a stored [] as a deliberately-empty home that
  // wins over the legacy synthesis, so a garbled save would blank the homepage while
  // reporting success. A genuinely-empty layout still posts "[]" (a valid array) and passes.
  const rawBlocks = formData.get("blocks");
  if (parseJsonArrayField(rawBlocks).malformed) {
    return { ok: false, error: "validation", message: "Données de mise en page invalides. Rechargez la page puis réessayez." };
  }
  const blocks = parseHomeBlocks(String(rawBlocks ?? ""));
  const res = await workflows.cms.upsertSetting(
    {
      key: "home.blocks",
      value: serializeHomeBlocks(blocks),
      type: "text" as never,
      groupKey: "home",
      label: "Accueil — composition des blocs",
    },
    { actorUserId: session.user.id },
  );
  if (!res.ok) return { ok: false, error: res.error, message: res.message };
  revalidatePath("/admin/cms/home");
  revalidatePath("/", "layout");
  return { ok: true, message: `Page d'accueil enregistrée (${blocks.length} blocs).` };
}
