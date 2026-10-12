"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";

/**
 * Persist the storefront theme tokens (`theme.*`). Mirrors saveSiteSettingsAction:
 * requirePermission → one upsertSetting per key → revalidate the admin page AND
 * the storefront layout (so the injected CSS variables + favicon refresh).
 *
 * Colors are validated here (strict hex) so a bad paste is rejected with an
 * inline message rather than silently falling back to the default on read
 * (getThemeConfig still re-validates as a defence-in-depth backstop).
 */
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const COLOR_FIELDS: Array<{ key: string; label: string }> = [
  { key: "theme.primary_color", label: "Couleur principale" },
  { key: "theme.primary_foreground", label: "Texte sur couleur principale" },
  { key: "theme.accent_color", label: "Couleur d'accent" },
  { key: "theme.accent_foreground", label: "Texte sur couleur d'accent" },
  { key: "theme.foreground_color", label: "Couleur du texte" },
  // ── Admin-panel theme (separate surface; injected `.admin`-scoped) ──
  { key: "admin.theme.accent_color", label: "Admin — couleur d'accent" },
  { key: "admin.theme.accent_strong", label: "Admin — accent foncé (survol)" },
  { key: "admin.theme.secondary_color", label: "Admin — couleur secondaire" },
  { key: "admin.theme.gold_color", label: "Admin — libellés dorés" },
  { key: "admin.theme.background_color", label: "Admin — fond du contenu" },
  { key: "admin.theme.sidebar_color", label: "Admin — fond de la barre latérale" },
];

// Media-id + plain text/number tokens (no per-field validation beyond clamping).
const SIMPLE_FIELDS: Array<{ key: string; label: string; type: "text" | "number" | "media" }> = [
  { key: "theme.border_radius_base", label: "Arrondi de base", type: "number" },
  { key: "theme.font_family", label: "Police", type: "text" },
  { key: "admin.theme.font", label: "Admin — police d'interface", type: "text" },
  { key: "admin.theme.heading_font", label: "Admin — police des titres", type: "text" },
  { key: "admin.theme.logo_media_id", label: "Admin — logo", type: "media" },
  { key: "theme.dark_mode", label: "Mode sombre", type: "text" },
  { key: "theme.favicon_media_id", label: "Favicon", type: "media" },
  { key: "theme.default_og_media_id", label: "Image de partage par défaut", type: "media" },
];

export async function saveThemeSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("settings_theme", "update");

  // Validate colors up front so we never persist a partial set.
  for (const f of COLOR_FIELDS) {
    const value = String(formData.get(f.key) ?? "").trim();
    if (value && !HEX_RE.test(value)) {
      return {
        ok: false,
        error: "invalid",
        message: `${f.label} : code couleur hexadécimal invalide (ex. #4E6F3D).`,
      };
    }
  }

  // One ATOMIC batch (one transaction) — a mid-write DB failure can't leave the
  // theme half-applied (mirrors saveFooterAction; was a per-key loop).
  const settings = [
    ...COLOR_FIELDS.map((f) => ({
      key: f.key,
      value: String(formData.get(f.key) ?? "").trim(),
      type: "text" as const,
      groupKey: "theme",
      label: f.label,
    })),
    ...SIMPLE_FIELDS.map((f) => {
      let value = String(formData.get(f.key) ?? "").trim();
      if (f.type === "number" && value) {
        // Same rule as the storefront reader (radiusPx): clamp to 0–28 with 0
        // kept (square corners); a non-numeric value is stored BLANK so it reads
        // as the default — it used to be coerced to 0 (square) instead.
        const n = Number(value);
        value = Number.isFinite(n) ? String(Math.max(0, Math.min(28, Math.round(n)))) : "";
      }
      return { key: f.key, value, type: f.type, groupKey: "theme", label: f.label };
    }),
  ];

  const res = await workflows.cms.upsertSettingsBatch(
    { settings },
    { actorUserId: session.user.id },
  );
  if (!res.ok) return { ok: false, error: res.error, message: res.message };

  revalidatePath("/admin/cms/theme");
  revalidatePath("/", "layout");
  return { ok: true, message: "Thème enregistré." };
}
