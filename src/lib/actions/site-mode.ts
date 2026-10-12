"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { parseSiteMode } from "@/lib/site-mode/parse";
import { workflows } from "@/workflows";

/**
 * Persist the site-availability settings (Système → Redirections & 404 →
 * « Maintenance »). Reuses the `system_redirects` permission — the maintenance /
 * coming-soon page is the sibling of the 404 page (same scene, same "site-state"
 * surface). After saving it busts the storefront layout so the gate re-reads the
 * new mode on the next request (no wait for the settings cache TTL).
 */
export async function saveSiteModeSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_redirects", "manage");

  // Mode — validated against the enum (unknown ⇒ live), never stored raw.
  const mode = parseSiteMode(String(formData.get("site.mode") ?? ""));
  const modeRes = await workflows.cms.upsertSetting(
    {
      key: "site.mode",
      value: mode,
      type: "text" as never,
      groupKey: "site",
      label: "Disponibilité du site",
    },
    { actorUserId: session.user.id },
  );
  if (!modeRes.ok) return { ok: false, error: modeRes.error, message: modeRes.message };

  const TEXT: Array<{ key: string; label: string; max: number }> = [
    { key: "site.maintenance_title", label: "Maintenance — titre", max: 120 },
    { key: "site.maintenance_message", label: "Maintenance — message", max: 400 },
    // datetime-local value ("YYYY-MM-DDTHH:mm"); resolver Date.parse-normalizes it.
    { key: "site.launch_at", label: "Maintenance — date de lancement", max: 40 },
  ];
  for (const f of TEXT) {
    const res = await workflows.cms.upsertSetting(
      {
        key: f.key,
        value: String(formData.get(f.key) ?? "").trim().slice(0, f.max),
        type: "text" as never,
        groupKey: "site",
        label: f.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  const countdownRes = await workflows.cms.upsertSetting(
    {
      key: "site.show_countdown",
      value: formData.get("site.show_countdown") === "on" ? "true" : "false",
      type: "boolean" as never,
      groupKey: "site",
      label: "Maintenance — afficher le compte à rebours",
    },
    { actorUserId: session.user.id },
  );
  if (!countdownRes.ok) return { ok: false, error: countdownRes.error, message: countdownRes.message };

  revalidatePath("/admin/system/redirects");
  // Bust the storefront layout so the gate reflects the new mode immediately.
  revalidatePath("/", "layout");

  const modeLabel =
    mode === "live" ? "Site en ligne" : mode === "maintenance" ? "Maintenance activée" : "Mode « bientôt » activé";
  return { ok: true, message: `Réglages enregistrés — ${modeLabel}.` };
}
