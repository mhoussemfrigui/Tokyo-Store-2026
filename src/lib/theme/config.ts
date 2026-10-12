import "server-only";

import { cache } from "react";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { mediaQueries } from "@/modules/media";

/**
 * DB-driven theme/design tokens, admin-controlled via `theme.*` settings and
 * injected into the storefront as live CSS variables (see the shop layout). The
 * defaults below mirror `globals.css`, so an unconfigured site renders exactly
 * as before — setting a key overrides only that token on the next request.
 *
 * Colors override the `:root` custom properties that `globals.css` already
 * routes through `@theme inline` (so `bg-primary`, `text-foreground`, … pick
 * them up). Radius overrides the single `--radius` base; the sm…2xl scale is
 * derived from it via calc() in globals.css, so one value rescales the system.
 *
 * SECURITY: every value is validated before it reaches the injected <style>.
 * Colors must be strict hex, radius is clamped to a range, and the font must be
 * one of a curated allowlist — a raw settings string never lands in CSS.
 */

export type ThemeDarkMode = "off" | "system" | "on";

export type ThemeConfig = {
  primaryColor: string;
  primaryForeground: string;
  accentColor: string;
  accentForeground: string;
  foregroundColor: string;
  radiusBasePx: number;
  /**
   * The CSS-variable overrides to inject — ONLY the tokens the operator
   * explicitly set (valid hex colour, in-range radius, non-default font),
   * already mapped to their CSS var names. Empty ⇒ `buildThemeCss` emits nothing
   * and the `globals.css` scope defaults stand untouched. This is what keeps an
   * unconfigured store byte-identical to today.
   */
  cssOverrides: Record<string, string>;
  /**
   * The subset of `cssOverrides` (brand/accent tokens only) that must also win in
   * dark mode — emitted under an `html.dark`-qualified selector so it beats the
   * higher-specificity dark palette. Text/surface tokens are intentionally absent
   * so the operator's light-mode ink never lands on the dark background.
   */
  cssOverridesDark: Record<string, string>;
  /** Admin-forced dark-mode default; the visitor toggle can still override. */
  darkMode: ThemeDarkMode;
  faviconMediaId: string | null;
  /** Resolved favicon URL (médiathèque → /cdn), or null to fall back to icon.svg. */
  faviconUrl: string | null;
  // NOTE: theme.default_og_media_id is NOT surfaced here — getSeoConfig reads that
  // key directly for the OG fallback chain (src/lib/seo/config.ts), so exposing a
  // second, unread copy on ThemeConfig would be a dead field.
};

// These are the storefront's EFFECTIVE default tokens — the crimson Tokyo system
// (`.tokyo` in `globals.css`). `buildThemeCss` injects ONLY the tokens the
// operator explicitly SET, as `.tokyo{…}` + `.storefront{…}` overrides, so an
// unconfigured store keeps the `globals.css` defaults untouched (byte-identical
// to today). The hex values here are the equivalents of the `.tokyo` oklch
// defaults; they are used for the admin panel's placeholders and for the
// app-wide brand-colour fallbacks (PWA `theme_color`, root `themeColor`, email
// brand). KEEP IN SYNC with the `.tokyo` block.
export const THEME_DEFAULTS = {
  primaryColor: "#d40530", // Tokyo crimson — .tokyo --primary
  primaryForeground: "#ffffff", // .tokyo --primary-foreground
  accentColor: "#886E5C", // muted gold/taupe — the effective --gold on .tokyo CMS pages
  accentForeground: "#ffffff", // .tokyo --gold-foreground
  foregroundColor: "#0e1218", // ink — .tokyo --foreground
  radiusBasePx: 20, // 1.25rem
} as const;

/**
 * Curated, injection-safe font stacks the admin can pick from (key → CSS). Any
 * non-default stack replaces BOTH the body and the heading font (buildThemeCss).
 */
export const THEME_FONT_STACKS: Record<string, string> = {
  // Default — no override: keeps each scope's own bundled faces (the live
  // `.tokyo` store: Figtree body + Outfit headings; the legacy `.storefront`:
  // Montserrat + Playfair). The key stays `manrope` for settings already stored
  // under it.
  manrope: "",
  system:
    'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  geometric: '"Century Gothic", "URW Gothic", "Futura", sans-serif',
  rounded: '"Trebuchet MS", "Segoe UI", Verdana, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
};

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function str(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t.length ? t : null;
}
/** Accept only strict hex; anything else falls back to the default (no injection). */
function hex(v: string | null | undefined, fallback: string): string {
  const t = str(v);
  return t && HEX_RE.test(t) ? t : fallback;
}
/**
 * Base radius in px, clamped to 0–28. 0 is a real choice (square corners); only
 * a BLANK / non-numeric value falls back to the default — `Number("")` is 0, so
 * an unset key used to render square corners while the admin slider showed 12.
 * The admin panel (client) and the save action mirror this exact rule.
 */
export function radiusPx(v: string | null | undefined, fallback: number): number {
  const t = (v ?? "").trim();
  if (!t) return fallback;
  const n = Number(t);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(28, Math.round(n)));
}
function darkMode(v: string | null | undefined): ThemeDarkMode {
  const t = (v ?? "").trim().toLowerCase();
  return t === "on" || t === "system" ? t : "off";
}

/**
 * Per-request memoized (React cache): called from the shop layout, the root
 * generateMetadata + generateViewport, and the manifest — all in one request.
 * Caching dedupes the favicon média resolve down to a single lookup.
 */
export const getThemeConfig = cache(async (): Promise<ThemeConfig> => {
  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    // settings unavailable → all defaults below keep the storefront branded
  }

  const fontKey = str(s["theme.font_family"])?.toLowerCase() ?? "manrope";
  const fontStack = THEME_FONT_STACKS[fontKey] ?? "";

  // CSS-var overrides — ONLY the tokens the operator explicitly set (and valid).
  // An unset / blank / invalid key is OMITTED so the globals.css scope default
  // (the crimson `.tokyo` oklch palette, the legacy olive `.storefront`) stands.
  // This is the Option-A safety net: no injection until the admin edits a field.
  //
  // `cssOverridesDark` is the subset that must ALSO win in dark mode. globals.css
  // declares the dark palettes with a higher-specificity selector
  // (`html.dark .tokyo` = 0,2,1) than our injected base rule (`.tokyo` = 0,1,0),
  // so without a dark-qualified rule the operator's brand colour would be silently
  // dropped in dark mode. Only the BRAND/ACCENT tokens belong here — the text /
  // surface tokens (--foreground &co.) are deliberately left to the dark palette
  // (the operator's LIGHT-mode ink must NOT leak onto the dark background).
  const cssOverrides: Record<string, string> = {};
  const cssOverridesDark: Record<string, string> = {};
  const setHex = (key: string, vars: string[], darkSafe = false) => {
    const t = str(s[key]);
    if (t && HEX_RE.test(t)) {
      for (const v of vars) {
        cssOverrides[v] = t;
        if (darkSafe) cssOverridesDark[v] = t;
      }
    }
  };
  // Mapping: control name → the `.tokyo` / `.storefront` tokens it drives.
  // (darkSafe = the brand/accent tokens that should apply in dark mode too.)
  setHex("theme.primary_color", ["--primary", "--primary-hover", "--ring"], true);
  setHex("theme.primary_foreground", ["--primary-foreground"], true);
  setHex("theme.foreground_color", ["--foreground", "--ink", "--card-foreground", "--popover-foreground"]);
  setHex("theme.accent_color", ["--gold"], true);
  setHex("theme.accent_foreground", ["--gold-foreground"], true);
  const radiusRaw = (s["theme.border_radius_base"] ?? "").trim();
  if (radiusRaw) {
    const n = Number(radiusRaw);
    // The dark palette does NOT re-declare --radius or the font vars, so the base
    // `.tokyo` rule already applies them in dark mode — no dark-qualified rule needed.
    if (Number.isFinite(n)) cssOverrides["--radius"] = `${Math.max(0, Math.min(28, Math.round(n)))}px`;
  }
  if (fontStack) {
    // `.tokyo` re-points --font-sans/--font-display (the @theme-mapped roles) in
    // addition to --font-body/--font-heading, so override all four.
    for (const v of ["--font-body", "--font-heading", "--font-sans", "--font-display"]) {
      cssOverrides[v] = fontStack;
    }
  }

  const faviconMediaId = str(s["theme.favicon_media_id"]);
  let faviconUrl: string | null = null;
  if (faviconMediaId) {
    // Same resolver the shop layout uses for the logo → same-origin /cdn URL.
    faviconUrl = await mediaQueries.resolveUrlById(faviconMediaId).catch(() => null);
  }

  return {
    primaryColor: hex(s["theme.primary_color"], THEME_DEFAULTS.primaryColor),
    primaryForeground: hex(s["theme.primary_foreground"], THEME_DEFAULTS.primaryForeground),
    accentColor: hex(s["theme.accent_color"], THEME_DEFAULTS.accentColor),
    accentForeground: hex(s["theme.accent_foreground"], THEME_DEFAULTS.accentForeground),
    foregroundColor: hex(s["theme.foreground_color"], THEME_DEFAULTS.foregroundColor),
    radiusBasePx: radiusPx(s["theme.border_radius_base"], THEME_DEFAULTS.radiusBasePx),
    cssOverrides,
    cssOverridesDark,
    darkMode: darkMode(s["theme.dark_mode"]),
    faviconMediaId,
    faviconUrl,
  };
});

/**
 * Build the CSS text injected app-wide (root layout), scoped to the two
 * storefront design systems: `.tokyo` (the LIVE crimson store) and `.storefront`
 * (the legacy routes). It emits ONLY `cfg.cssOverrides` — the tokens the operator
 * explicitly set — so an unconfigured store injects NOTHING and the globals.css
 * scope defaults stand (byte-identical to today). Admin chrome (`.admin`) has its
 * own injector and is untouched. Values are validated in `getThemeConfig` →
 * injection-safe.
 */
export function buildThemeCss(cfg: ThemeConfig): string {
  const entries = Object.entries(cfg.cssOverrides);
  if (!entries.length) return "";
  const body = entries.map(([k, v]) => `${k}:${v}`).join(";");
  let css = `.tokyo{${body}}.storefront{${body}}`;
  // Dark mode: the base `.tokyo` rule (0,1,0) loses to globals.css's
  // `html.dark .tokyo` (0,2,1), so re-emit the brand/accent subset under the same
  // higher-specificity, `html.dark`-qualified selector. Equal specificity to the
  // palette + later document order ⇒ the operator's brand colour wins in dark too.
  const darkEntries = Object.entries(cfg.cssOverridesDark);
  if (darkEntries.length) {
    const darkBody = darkEntries.map(([k, v]) => `${k}:${v}`).join(";");
    css += `html.dark .tokyo{${darkBody}}html.dark .storefront{${darkBody}}`;
  }
  return css;
}
