/**
 * Banner model — the pure, surface-agnostic pieces for the enhanced `banners` row
 * (Contenu & Design → Bannières): the editable-buttons array (parse / serialize / the
 * operator-design → shared button-system mapping) and the grid-position / header-strip-tone
 * value sets. Used by the admin form, the workflow validation, and the storefront renderers.
 *
 * Pure: no React, no server-only, no DB.
 */
import type { ButtonVariant } from "@/components/ui/button";
import { safeHref } from "@/lib/utils/safe-href";

/** A real link target, or "" — safeHref maps a blank value to "#", which is not a real link. */
const realHref = (v: string): string => {
  const h = safeHref(v);
  return h && h !== "#" ? h : "";
};

// ── Editable buttons (home hero + any CTA-bearing banner) ──────────────────────
/** The operator-facing button DESIGNS (requirement #5). Each maps to the shared
 *  `buttonVariants()` args below, so a banner button uses the exact site button system. */
export const BANNER_BUTTON_VARIANTS = ["primary", "secondary", "onyx", "ghost", "link", "on-photo"] as const;
export type BannerButtonVariant = (typeof BANNER_BUTTON_VARIANTS)[number];

/** Design → shared button-system args. `on-photo` is the legible-over-a-photo light treatment
 *  the home hero uses (secondary outline + the on-dark palette). */
export const BANNER_BUTTON_STYLE: Record<BannerButtonVariant, { variant: ButtonVariant; onDark?: boolean }> = {
  primary: { variant: "primary" },
  secondary: { variant: "secondary" },
  onyx: { variant: "primary-onyx" },
  ghost: { variant: "ghost" },
  link: { variant: "link" },
  "on-photo": { variant: "secondary", onDark: true },
};

/** Composer labels for the design selector. */
export const BANNER_BUTTON_VARIANT_LABELS: Record<BannerButtonVariant, string> = {
  primary: "Principal (plein)",
  secondary: "Contour",
  onyx: "Plein foncé",
  ghost: "Discret",
  link: "Lien texte",
  "on-photo": "Sur photo (clair)",
};

export type BannerButton = { label: string; href: string; variant: BannerButtonVariant };

/** Max editable buttons per banner — a hero needs 1–2; cap generously. */
export const MAX_BANNER_BUTTONS = 4;

const isVariant = (v: unknown): v is BannerButtonVariant =>
  typeof v === "string" && (BANNER_BUTTON_VARIANTS as readonly string[]).includes(v);

function parseBannerButton(v: unknown): BannerButton | null {
  const o = (v ?? {}) as Record<string, unknown>;
  const label = String(o.label ?? "").trim().slice(0, 80);
  const href = realHref(String(o.href ?? "").trim());
  if (!label || !href) return null; // a CTA needs both a label AND a real link
  return { label, href, variant: isVariant(o.variant) ? o.variant : "primary" };
}

/** Parse the stored `banners.buttons` JSON into a clean, sanitised button list (never throws;
 *  bad entries dropped, hrefs safe-href'd, capped). [] for absent/garbled input. */
export function parseBannerButtons(raw: string | null | undefined): BannerButton[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: BannerButton[] = [];
  for (const item of arr) {
    const b = parseBannerButton(item);
    if (b) out.push(b);
    if (out.length >= MAX_BANNER_BUTTONS) break;
  }
  return out;
}

export function serializeBannerButtons(buttons: BannerButton[]): string {
  return JSON.stringify(buttons);
}

/** The EFFECTIVE buttons for a banner. A NON-NULL `buttons` column is AUTHORITATIVE — the
 *  operator saved through the new editor, so its (possibly empty) list wins and the legacy
 *  columns are ignored; this is what lets an operator CLEAR a hero's CTAs (an empty editor
 *  stores `"[]"`, not NULL). Only a NULL `buttons` column (a pre-0177 banner never re-saved
 *  through the editor) falls back to synthesising from the legacy cta_* / secondary_cta_*. */
export function effectiveBannerButtons(b: {
  buttons: string | null;
  cta_label: string | null;
  cta_href: string | null;
  secondary_cta_label: string | null;
  secondary_cta_href: string | null;
}): BannerButton[] {
  if (b.buttons != null) return parseBannerButtons(b.buttons);
  const legacy: BannerButton[] = [];
  const primaryHref = realHref(b.cta_href ?? "");
  if (b.cta_label && primaryHref) legacy.push({ label: b.cta_label, href: primaryHref, variant: "on-photo" });
  const secondaryHref = realHref(b.secondary_cta_href ?? "");
  if (b.secondary_cta_label && secondaryHref) legacy.push({ label: b.secondary_cta_label, href: secondaryHref, variant: "link" });
  return legacy;
}

// ── category_grid position (requirement #6) ────────────────────────────────────
/** Where a between-products banner appears: above the listing, after the first « Charger plus »
 *  block only, or repeating every N blocks (N = after_load_more_count — the legacy cadence). */
export const GRID_POSITIONS = ["top", "after_load_more", "after_rows"] as const;
export type GridPosition = (typeof GRID_POSITIONS)[number];
export const GRID_POSITION_LABELS: Record<GridPosition, string> = {
  top: "En haut (au-dessus de la liste)",
  after_load_more: "Après le 1er « Charger plus »",
  // The cadence unit is a « bloc » = one 20-produits « Charger plus » page, NOT a grid row.
  after_rows: "Tous les N blocs (« Charger plus », répété)",
};
export const coerceGridPosition = (v: unknown): GridPosition =>
  typeof v === "string" && (GRID_POSITIONS as readonly string[]).includes(v) ? (v as GridPosition) : "after_rows";

// ── header_strip tone (requirement #7) ─────────────────────────────────────────
export const STRIP_TONES = ["olive", "dark", "gold", "burgundy"] as const;
export type StripTone = (typeof STRIP_TONES)[number];
export const STRIP_TONE_LABELS: Record<StripTone, string> = {
  olive: "Olive (défaut)",
  dark: "Onyx (foncé)",
  gold: "Or",
  burgundy: "Bordeaux",
};
export const coerceStripTone = (v: unknown): StripTone =>
  typeof v === "string" && (STRIP_TONES as readonly string[]).includes(v) ? (v as StripTone) : "olive";

/** Human labels for every banner placement (incl. the legacy nav_* + checkout).
 *  One source of truth for the banner-form selector + the banners-panel tabs. */
export const PLACEMENT_LABELS: Record<string, string> = {
  home_hero: "Hero accueil",
  header_strip: "Bandeau header",
  category_grid: "Entre les produits (listing)",
  footer: "Footer",
  checkout: "Checkout",
  nav_boutique: "Menu Boutique (image vedette)",
  nav_marques: "Menu Marques (image vedette)",
  nav_maison: "Menu Maison (image vedette)",
};
