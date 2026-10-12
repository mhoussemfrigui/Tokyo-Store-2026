/**
 * SHARED, pure block-composer model — the generic core reused by BOTH the HOME composer
 * (home-blocks.ts) and the PAGES composer (page-blocks.ts). No "server-only" / DB import,
 * so it unit-tests in the fast lane and any save action can import it without dragging in
 * the settings/DB chain.
 *
 * It owns the surface-agnostic pieces: the block sub-shapes (header / image / card / faq),
 * the product-source selector, per-block PRESENTATION (background / spacing / alignment /
 * width / divider), the médiathèque IMAGE_RECO hints, the field coercers, and the generic
 * instance-array parser `parseBlockList` (a stored JSON array of {id, type, visible,
 * config}). Each SURFACE module supplies its own TYPE catalog + per-type config parse and
 * calls `parseBlockList` with them.
 */

import { clampInt, coerceEnum, coerceMediaId } from "./boutique-landing-parse";
import { safeHref } from "@/lib/utils/safe-href";

// ── Product source (the "filterable" part of listing blocks) ────────────────
export const PRODUCT_SOURCE_MODES = [
  "new", // newest published
  "best_sellers", // top sellers over a window
  "on_promotion", // active auto-promotion pool
  "category", // products in a category (by slug)
  "brand", // products of a brand (by slug)
  "manual", // an explicit, ordered list of product ids (pins)
] as const;
export type ProductSourceMode = (typeof PRODUCT_SOURCE_MODES)[number];

export const PROMO_STRATEGIES = ["engine", "compare_at", "both"] as const;
export type PromoStrategy = (typeof PROMO_STRATEGIES)[number];

/** A validated, render-ready product-source selector. `ref` carries the slug for
 *  category/brand; `productIds` the pins for manual; the extras tune the
 *  algorithmic modes. Absent/garbled fields fall back to safe defaults at parse. */
export type ProductSource = {
  mode: ProductSourceMode;
  ref: string; // category/brand slug (empty for the algorithmic modes)
  productIds: string[]; // manual pins (empty otherwise)
  windowDays: number; // best_sellers window (default 30)
  promoStrategy: PromoStrategy; // on_promotion ranking
};

/** Common presentational fields shared by most blocks (all optional → hidden when
 *  blank at render, mirroring the existing hide-when-unset behaviour). */
export type BlockHeader = {
  eyebrow: string;
  title: string;
  subtitle: string;
  ctaLabel: string;
  ctaHref: string;
};

/** The all-blank header — the ONE shared fallback for a block with no header (matches
 *  parseHeader(undefined)). Used by the renderer, the composer and the legacy synthesiser
 *  so they never drift if BlockHeader gains a field. */
export const EMPTY_HEADER: BlockHeader = { eyebrow: "", title: "", subtitle: "", ctaLabel: "", ctaHref: "" };

/** One image slot: a médiathèque id (never an inline URL) + alt/caption overrides. */
export type BlockImage = { mediaId: string; alt: string };

/** A card in the 50/50, feature, and trust blocks. */
export type BlockCard = {
  eyebrow: string;
  title: string;
  body: string;
  /** feature_cards only: a price/badge line. */
  meta: string;
  ctaLabel: string;
  ctaHref: string;
  image: BlockImage | null;
  /** trust only: a lucide icon key (rendered when no image). */
  icon: string;
};

export type FaqItem = { question: string; answer: string };

// ── Canonical section layout (ONE source of truth, copied from the listing pages) ──
// Every storefront section — home blocks, CMS page blocks, system/help pages — wraps its
// content in THIS container so the whole site shares the exact same horizontal size and
// gutters as the category/brand listing pages (max-w-[1400px], 16→32→48px gutters). Do not
// inline a different max-w/px anywhere; reference these instead.
export const SECTION_MAXW = "max-w-[1400px]";
export const SECTION_GUTTER = "px-5 md:px-8 lg:px-12";
export const SECTION_CONTAINER = `mx-auto w-full ${SECTION_MAXW} ${SECTION_GUTTER}`;

// ── Per-block PERSONALISATION (applies to every block's section wrapper) ───────
export const BLOCK_BACKGROUNDS = ["default", "surface", "muted", "dark", "olive"] as const;
export const BLOCK_PADDINGS = ["default", "tight", "spacious", "none"] as const;
export const BLOCK_ALIGNS = ["left", "center"] as const;
export const BLOCK_WIDTHS = ["default", "wide", "full"] as const;
export type BlockPresentation = {
  /** Section background tone (maps to theme tokens in the renderer). */
  background: (typeof BLOCK_BACKGROUNDS)[number];
  /** Vertical rhythm of the section. */
  padding: (typeof BLOCK_PADDINGS)[number];
  /** Header/content alignment. */
  align: (typeof BLOCK_ALIGNS)[number];
  /** Content container width. */
  width: (typeof BLOCK_WIDTHS)[number];
  /** Draw a hairline divider above the block. */
  divider: boolean;
};
export const DEFAULT_PRESENTATION: BlockPresentation = {
  background: "default",
  padding: "default",
  align: "left",
  width: "default",
  // Divider defaults OFF. On the HOME it is force-normalised away (sections are separated
  // by a very soft content-column hairline decided by planSeams — no composer toggle sets
  // it). On the content PAGES it is honoured only for hand-authored / legacy stored blocks.
  divider: false,
};

/**
 * Recommended source dimensions per image SLOT — shown to the operator next to each
 * MediaPicker so uploads are crisp on retina without being over-weight. Aspect ratio
 * is the hard requirement (the slot crops to it); px is the sweet spot.
 */
export const IMAGE_RECO = {
  hero_mobile: "Portrait 4:5 — 1080×1350 px",
  banner_desktop: "Bannière large 21:9 — 2400×1030 px",
  banner_fullbleed: "Pleine largeur 32:9 — 2880×810 px (min 2000×560)",
  banner_mobile: "Carré/portrait 4:5 — 1080×1350 px",
  editorial_desktop: "Portrait 4:5 — 1200×1500 px",
  editorial_mobile: "Paysage 3:2 — 1200×800 px",
  card_landscape: "Paysage 3:2 — 1200×800 px",
  square: "Carré 1:1 — 1000×1000 px",
} as const;
export type ImageRecoKey = keyof typeof IMAGE_RECO;

// ── Parse / validate ─────────────────────────────────────────────────────────
/** Max length for ONE text field — a per-field bound, not a total-size cap. The whole blob
 *  is bounded instead by the block cap (40) × the per-type array caps (cards/steps/faq/…) ×
 *  this limit, and by the server-action body limit on the save path; it is not a single hard
 *  ceiling, so a maximally-dense layout can still reach a few MB. */
export const MAX_TEXT = 2000;
export const asStr = (v: unknown): string =>
  typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "";
export const asBool = (v: unknown, dflt = true): boolean =>
  typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : dflt;

export function parseHeader(raw: unknown): BlockHeader {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    eyebrow: asStr(o.eyebrow),
    title: asStr(o.title),
    subtitle: asStr(o.subtitle),
    ctaLabel: asStr(o.ctaLabel),
    ctaHref: safeHref(asStr(o.ctaHref)),
  };
}

export function parseImage(raw: unknown): BlockImage | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mediaId = coerceMediaId(o.mediaId);
  if (!mediaId) return null;
  return { mediaId, alt: asStr(o.alt) };
}

export function parseSource(raw: unknown): ProductSource {
  const o = (raw ?? {}) as Record<string, unknown>;
  const mode = coerceEnum(o.mode, PRODUCT_SOURCE_MODES, "new");
  // Manual pins are the ONE id list that hits a typed `uuid` column directly (products.id,
  // via listProductsByIds' inArray). A single non-UUID token would make Postgres throw
  // 22P02 for the WHOLE IN(...) — blanking the block. Gate each id through the UUID-shape
  // coercer and drop malformed tokens so valid pins survive.
  const ids = Array.isArray(o.productIds)
    ? [...new Set(o.productIds.map((x) => coerceMediaId(x)).filter(Boolean))].slice(0, 50)
    : [];
  return {
    mode,
    ref: asStr(o.ref).slice(0, 200),
    productIds: ids,
    windowDays: clampInt(o.windowDays, 30, 1, 365),
    promoStrategy: coerceEnum(o.promoStrategy, PROMO_STRATEGIES, "both"),
  };
}

export function parseCard(raw: unknown): BlockCard {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    eyebrow: asStr(o.eyebrow),
    title: asStr(o.title),
    body: asStr(o.body),
    meta: asStr(o.meta),
    ctaLabel: asStr(o.ctaLabel),
    ctaHref: safeHref(asStr(o.ctaHref)),
    image: parseImage(o.image),
    icon: asStr(o.icon),
  };
}

export function parseRefs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  // Each ref is a slug — cap the token length (defensive; slugs are short) and the count.
  return [...new Set(raw.map((x) => String(x ?? "").trim().slice(0, 200)).filter(Boolean))].slice(0, 40);
}

/** Coerce the personalisation (section wrapper) config — shared by every block. */
export function parsePresentation(raw: unknown): BlockPresentation {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    background: coerceEnum(o.background, BLOCK_BACKGROUNDS, "default"),
    padding: coerceEnum(o.padding, BLOCK_PADDINGS, "default"),
    align: coerceEnum(o.align, BLOCK_ALIGNS, "left"),
    width: coerceEnum(o.width, BLOCK_WIDTHS, "default"),
    // Default OFF when the field is absent (or the string "false"): sections are separated
    // by their rhythm + tone, not a hairline under every block (the "separators here and
    // there" complaint). Only an explicit boolean true / the string "true" turns it on — so
    // a hand-authored or seeded block that omits `divider` never draws a rule.
    divider: typeof o.divider === "boolean" ? o.divider : o.divider === "true",
  };
}

/** A short, collision-resistant id for a new block (no crypto needed — stable key). */
export function newBlockId(): string {
  return "b_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ── Generic instance-array parser ──────────────────────────────────────────────
/** A placed block instance. `id` is a stable client-generated key (reorder/remove). */
export type Block<TType extends string, TConfig> = {
  id: string;
  type: TType;
  visible: boolean;
  config: TConfig;
};

/** Max blocks a composed layout may hold (home + pages). The composer disables its Add
 *  palette at this count; the parser drops any overflow on save. */
export const BLOCK_LIST_CAP = 40;

/**
 * Parse a stored block-array JSON string into a clean, validated list: drop non-objects +
 * unknown types, coerce each config via the surface's `parseConfig`, give every block a
 * stable unique id + a visible flag, and cap the list. Returns [] for absent/garbled input
 * so the caller can fall back to a synthesised default. Shared by home + pages.
 */
export function parseBlockList<TType extends string, TConfig>(
  raw: string | null | undefined,
  isKnownType: (t: string) => t is TType,
  parseConfig: (type: TType, rawConfig: unknown) => TConfig,
  cap = BLOCK_LIST_CAP,
): Block<TType, TConfig>[] {
  if (!raw) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: Block<TType, TConfig>[] = [];
  for (const item of arr) {
    const o = (item ?? {}) as Record<string, unknown>;
    const type = asStr(o.type);
    if (!isKnownType(type)) continue;
    let id = asStr(o.id);
    // Regenerate a blank/duplicate id, and re-check the regenerated one so the "every id is
    // unique" invariant holds deterministically (not just with overwhelming probability).
    if (!id || seen.has(id)) {
      do {
        id = newBlockId();
      } while (seen.has(id));
    }
    seen.add(id);
    out.push({ id, type, visible: asBool(o.visible, true), config: parseConfig(type, o.config) });
    if (out.length >= cap) break;
  }
  return out;
}

/** Serialise a block list back to the stored JSON string (for the save action). */
export function serializeBlocks<TType extends string, TConfig>(blocks: Block<TType, TConfig>[]): string {
  return JSON.stringify(blocks);
}
