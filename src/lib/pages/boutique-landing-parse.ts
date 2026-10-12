/**
 * PURE, no-DB helpers shared by the settings-backed storefront landings (/boutique
 * AND /marques) — with NO "server-only" / DB import — so they unit-test in the fast
 * lane and the save actions can import them without dragging in the settings/DB read
 * chain. Holds: the stored-JSON parsers (FAQ, featured slug lists, trust points),
 * the save-time value guards (clampInt / coerceEnum / coerceMediaId), and the BLOCK
 * BUILDER models for both landings (BOUTIQUE_BLOCKS / MARQUES_BLOCKS + the generic
 * orderFromStored). The `*-landing-config` modules re-export these alongside their
 * DB-backed readers.
 */

// These parsers + types are landing-page AGNOSTIC (born on /boutique, reused by
// /marques). Generic aliases are exported at the bottom so a marques/other landing
// can import parseLandingFaq / parseLandingTrust / LandingFaq / LandingTrustItem
// without the "Boutique" wart, while /boutique keeps its original names.
export type BoutiqueLandingFaq = { question: string; answer: string };

/** A trust / reassurance point — same shape as the editorial value-prop cards
 *  ({icon lucide key, optional custom médiathèque image, title, body}). */
export type BoutiqueTrustItem = {
  icon: string;
  iconMediaId: string | null;
  title: string;
  body: string;
};

/** Parse the stored trust JSON into clean {icon, iconMediaId, title, body} items. */
export function parseBoutiqueTrust(raw: string | null | undefined): BoutiqueTrustItem[] {
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => {
        const o = (x ?? {}) as {
          icon?: unknown;
          iconMediaId?: unknown;
          title?: unknown;
          body?: unknown;
        };
        return {
          icon: String(o.icon ?? "").trim(),
          iconMediaId: o.iconMediaId ? String(o.iconMediaId) : null,
          title: String(o.title ?? "").trim(),
          body: String(o.body ?? "").trim(),
        };
      })
      .filter((x) => x.title.length > 0 || x.body.length > 0)
      .slice(0, 8);
  } catch {
    return [];
  }
}

/** Parse a stored JSON array of slugs into a clean, deduped string list. */
export function parseSlugList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return [
      ...new Set(arr.map((x) => String(x ?? "").trim()).filter((x) => x.length > 0)),
    ].slice(0, 60);
  } catch {
    return [];
  }
}

/** Parse the stored FAQ JSON into a clean, non-empty {question, answer} list. */
export function parseBoutiqueFaq(raw: string | null | undefined): BoutiqueLandingFaq[] {
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((x) => ({
        question: String((x as { question?: unknown })?.question ?? "").trim(),
        answer: String((x as { answer?: unknown })?.answer ?? "").trim(),
      }))
      .filter((x) => x.question.length > 0 && x.answer.length > 0)
      .slice(0, 30);
  } catch {
    return [];
  }
}

/**
 * Clamp a raw (string/number/FormData) value to an integer in [min, max], with a
 * fallback for NaN/non-finite input. Shared by the landing strip-caps at BOTH
 * read time and write time, so one test covers both clamps.
 */
export function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  // Treat empty/blank/absent as the fallback — NOT 0. `Number("")` is 0 (not NaN),
  // so without this an UNSET strip-cap setting would clamp to `min` (4) instead of
  // the intended default (12); the finite guard alone only catches "abc"-style NaN.
  const s = String(v ?? "").trim();
  if (s === "") return fallback;
  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), min), max);
}

/**
 * Parse a stored/submitted JSON value that MUST be an array. Distinguishes a
 * genuinely-absent field (null → not malformed) from a present-but-unparseable /
 * non-array value (→ malformed=true), so a save action can REJECT malformed data
 * instead of silently coercing curated FAQ/featured/trust fields to []. Shared by
 * the landing save actions (boutique/marques).
 */
export function parseJsonArrayField(raw: unknown): { arr: unknown[]; malformed: boolean } {
  if (raw == null) return { arr: [], malformed: false };
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (Array.isArray(parsed)) return { arr: parsed, malformed: false };
  } catch {
    /* fall through */
  }
  return { arr: [], malformed: true };
}

/**
 * Clean a raw featured-slug array (dedupe → trim → drop blanks → cap 60) and keep
 * only slugs present in `valid` (the LIVE rows — active OR not, so a temporarily
 * DEACTIVATED selection is preserved and only genuinely deleted/typo'd slugs are
 * dropped). Returns the kept slugs + how many were dropped (for the operator
 * message). Shared by the landing save actions.
 */
export function cleanFeaturedSlugs(
  arr: unknown[],
  valid: ReadonlySet<string>,
): { slugs: string[]; dropped: number } {
  const cleaned = [
    ...new Set(arr.map((x) => String(x ?? "").trim()).filter((x) => x.length > 0)),
  ].slice(0, 60);
  const known = cleaned.filter((slug) => valid.has(slug));
  return { slugs: known, dropped: cleaned.length - known.length };
}

/**
 * Keep a submitted value only if it is in the `allowed` list, else fall back —
 * so a crafted/garbled `<select>` value can never persist an unknown mode. Backs
 * the landing save actions' enum fields (hero style, source mode, section header
 * style…). Pure over the raw value so it is unit-testable without a FormData.
 */
export function coerceEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = String(value ?? "").trim();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * A submitted médiathèque id validated to the canonical UUID shape MediaPicker
 * posts (8-4-4-4-12 hex), or "" when absent/garbled. Backs the landing save actions'
 * dedicated image fields (the /boutique + /marques hero banner
 * desktop/mobile images), so a bogus value can never be stored as a media reference.
 */
export function coerceMediaId(value: unknown): string {
  const s = String(value ?? "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ? s : "";
}

// ── Generic landing aliases (reused by /marques + any future landing) ──────────
export const parseLandingFaq = parseBoutiqueFaq;
export const parseLandingTrust = parseBoutiqueTrust;
export type LandingFaq = BoutiqueLandingFaq;
export type LandingTrustItem = BoutiqueTrustItem;

// ── /boutique BLOCK BUILDER ──────────────────────────────────────────────────
// The /boutique landing is an ORDERED list of toggleable blocks. Kept here (the
// pure, no-DB module) so `parseBoutiqueBlockOrder` is fast-lane unit-testable and
// importable by the save action without dragging in the settings/DB read chain.

/** The reorderable content blocks on /boutique, top-to-bottom. */
export const BOUTIQUE_BLOCKS = [
  "hero",
  "categories",
  "brands",
  "editorial",
  "trust",
  "faq",
] as const;
export type BoutiqueBlockKey = (typeof BOUTIQUE_BLOCKS)[number];

/** Default order (also the fallback for any block missing from the stored order,
 *  so a newly-added block type auto-appears at the end). */
export const DEFAULT_BOUTIQUE_BLOCK_ORDER: BoutiqueBlockKey[] = [
  "hero",
  "categories",
  "brands",
  "editorial",
  "trust",
  "faq",
];

/** How the hero renders: the category CARDS chooser, or a dedicated image BANNER
 *  (its own desktop + mobile image, like the /marques hero banner). */
export type BoutiqueHeroStyle = "cards" | "banner";

/**
 * Generic block-order parser (shared by the /boutique + /marques builders): parse a
 * stored JSON order → a deduped, valid ordering. Unknown keys are dropped, then any
 * block MISSING from the stored order is appended — in `defaultOrder` first, then a
 * final sweep of `blocks` — so EVERY known block always appears (a newly-added block
 * type auto-appears at the end even if someone forgets to add it to `defaultOrder`).
 */
export function orderFromStored<T extends string>(
  raw: string | null | undefined,
  blocks: readonly T[],
  defaultOrder: readonly T[],
): T[] {
  let stored: string[] = [];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) stored = parsed.map((x) => String(x));
    } catch {
      /* fall through to default */
    }
  }
  const seen = new Set<T>();
  const out: T[] = [];
  for (const k of stored) {
    if ((blocks as readonly string[]).includes(k) && !seen.has(k as T)) {
      seen.add(k as T);
      out.push(k as T);
    }
  }
  for (const k of defaultOrder) if (!seen.has(k)) { seen.add(k); out.push(k); }
  // Safety net: a block in `blocks` but omitted from `defaultOrder` still renders
  // (else it would be silently unreachable on a fresh install).
  for (const k of blocks) if (!seen.has(k)) { seen.add(k); out.push(k); }
  return out;
}

/** Parse the stored /boutique block order (see {@link orderFromStored}). */
export function parseBoutiqueBlockOrder(raw: string | null | undefined): BoutiqueBlockKey[] {
  return orderFromStored(raw, BOUTIQUE_BLOCKS, DEFAULT_BOUTIQUE_BLOCK_ORDER);
}

// ── /marques BLOCK BUILDER (mirrors the /boutique block model) ────
/** The reorderable content blocks on the /marques brand index, top-to-bottom.
 *  `featured` = the curated "Marques en vedette" band; `grid` = the full A-Z index. */
export const MARQUES_BLOCKS = [
  "hero",
  "featured",
  "grid",
  "editorial",
  "trust",
  "faq",
] as const;
export type MarquesBlockKey = (typeof MARQUES_BLOCKS)[number];

/** Default order (also the fallback for any block missing from the stored order). */
export const DEFAULT_MARQUES_BLOCK_ORDER: MarquesBlockKey[] = [
  "hero",
  "featured",
  "grid",
  "editorial",
  "trust",
  "faq",
];

/** Parse the stored /marques block order (see {@link orderFromStored}). */
export function parseMarquesBlockOrder(raw: string | null | undefined): MarquesBlockKey[] {
  return orderFromStored(raw, MARQUES_BLOCKS, DEFAULT_MARQUES_BLOCK_ORDER);
}
