import "server-only";

import { cache } from "react";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { mediaQueries } from "@/modules/media";
import { THEME_FONT_STACKS } from "./config";

/**
 * Admin-panel theme — the "Tokyo Admin" design tokens, admin-EDITABLE under
 * /admin/cms/theme (the "Panneau admin" section). These override the static
 * `.admin{}` defaults in `globals.css` (injected late in the document, scoped to
 * `.admin`, so they never touch the storefront). Independent of the storefront
 * theme (`.storefront`-scoped) — the admin is its own surface. The owner asked
 * for admin-specific settings (font, secondary colour, …) rather than hardcoded
 * values; this is that layer.
 *
 * Both admin fonts are operator-switchable: `admin.theme.font` → `--font-body`
 * (UI + the sans section/card headings) and `admin.theme.heading_font` →
 * `--font-heading` (the serif DISPLAY moments: brand, page title, greeting, KPI
 * numbers). The sidebar logo is a média setting too (`admin.theme.logo_media_id`,
 * resolved to `logoUrl`). Colours are validated as strict hex → injection-safe.
 */
export const ADMIN_THEME_DEFAULTS = {
  accentColor: "#d40530", // Tokyo crimson — sidebar active, primary buttons, links, ring
  accentStrong: "#b8042a", // hover / pressed (crimson, matches the storefront system)
  secondaryColor: "#efe9e3", // secondary / outline-button surface (warm paper tint)
  goldColor: "#d40530", // section labels · "ADMINISTRATION" (crimson accent)
  backgroundColor: "#f6f2ed", // content area — warm paper canvas (the ADMIN UI design)
  sidebarColor: "#FFFFFF", // sidebar background
  /** Body/UI font key into THEME_FONT_STACKS; default keeps the loaded Figtree. */
  fontKey: "montserrat",
  /** Display/heading font key; "playfair" = no override, so the static `.admin`
   *  heading stack (Figtree — the ADMIN UI face) stands. */
  headingFontKey: "playfair",
} as const;

export type AdminThemeConfig = {
  accentColor: string;
  accentStrong: string;
  secondaryColor: string;
  goldColor: string;
  backgroundColor: string;
  sidebarColor: string;
  /** Resolved CSS body/UI font stack, or null to keep the static Montserrat. */
  fontFamily: string | null;
  fontKey: string;
  /** Resolved CSS heading/display font stack, or null to keep the static Playfair. */
  headingFontFamily: string | null;
  headingFontKey: string;
  /** Médiathèque media id of the sidebar logo (for the picker round-trip). */
  logoMediaId: string | null;
  /** Resolved sidebar logo URL, or null to fall back to the bundled RK mark. */
  logoUrl: string | null;
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
function hex(v: string | null | undefined, fallback: string): string {
  const t = (v ?? "").trim();
  return HEX_RE.test(t) ? t : fallback;
}
function str(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length ? t : null;
}

export const getAdminThemeConfig = cache(async (): Promise<AdminThemeConfig> => {
  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    // Cold DB / missing settings → defaults below.
  }
  const fontKey = str(s["admin.theme.font"])?.toLowerCase() ?? ADMIN_THEME_DEFAULTS.fontKey;
  // A known stack ("" for manrope, undefined for the default montserrat) → no
  // override; the static `.admin{}` keeps Figtree.
  const fontFamily = THEME_FONT_STACKS[fontKey] || null;
  // Heading/display font — default "playfair" resolves to no override so the
  // static `.admin{}` Figtree stands; any THEME_FONT_STACKS key overrides it.
  const headingFontKey =
    str(s["admin.theme.heading_font"])?.toLowerCase() ?? ADMIN_THEME_DEFAULTS.headingFontKey;
  const headingFontFamily = THEME_FONT_STACKS[headingFontKey] || null;
  // Admin-specific sidebar logo from the médiathèque; null → the admin layout
  // falls back to the storefront's site logo, then the shared bundled brand mark
  // (/tokyo-logo.png). No admin-only image asset is shipped.
  const logoMediaId = str(s["admin.theme.logo_media_id"]);
  const logoUrl = logoMediaId
    ? await mediaQueries.resolveUrlById(logoMediaId).catch(() => null)
    : null;
  return {
    accentColor: hex(s["admin.theme.accent_color"], ADMIN_THEME_DEFAULTS.accentColor),
    accentStrong: hex(s["admin.theme.accent_strong"], ADMIN_THEME_DEFAULTS.accentStrong),
    secondaryColor: hex(s["admin.theme.secondary_color"], ADMIN_THEME_DEFAULTS.secondaryColor),
    goldColor: hex(s["admin.theme.gold_color"], ADMIN_THEME_DEFAULTS.goldColor),
    backgroundColor: hex(s["admin.theme.background_color"], ADMIN_THEME_DEFAULTS.backgroundColor),
    sidebarColor: hex(s["admin.theme.sidebar_color"], ADMIN_THEME_DEFAULTS.sidebarColor),
    fontFamily,
    fontKey,
    headingFontFamily,
    headingFontKey,
    logoMediaId,
    logoUrl,
  };
});

/**
 * `.admin{ … }` CSS injected into <head>, overriding the static defaults. Every
 * value is validated above → injection-safe. The accent-soft / active-bg tints
 * derive from the chosen accent via `color-mix`, so changing the accent updates
 * the whole olive family in one move.
 */
export function buildAdminThemeCss(cfg: AdminThemeConfig): string {
  const vars: string[] = [
    `--primary:${cfg.accentColor}`,
    `--ring:${cfg.accentColor}`,
    `--olive:${cfg.accentColor}`,
    `--admin-accent-strong:${cfg.accentStrong}`,
    `--admin-accent-soft:color-mix(in srgb, ${cfg.accentColor} 12%, transparent)`,
    `--admin-side-active-bg:color-mix(in srgb, ${cfg.accentColor} 9%, transparent)`,
    `--secondary:${cfg.secondaryColor}`,
    `--gold:${cfg.goldColor}`,
    `--background:${cfg.backgroundColor}`,
    `--surface:${cfg.backgroundColor}`,
    `--admin-side-bg:${cfg.sidebarColor}`,
  ];
  if (cfg.fontFamily) vars.push(`--font-body:${cfg.fontFamily}`);
  if (cfg.headingFontFamily) vars.push(`--font-heading:${cfg.headingFontFamily}`);
  return `.admin{${vars.join(";")}}`;
}
