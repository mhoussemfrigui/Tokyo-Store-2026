/**
 * PURE, no-DB HOME block-composer catalog — the home surface's block TYPE list + per-type
 * CONFIG parse, built on the shared, surface-agnostic core in `block-model.ts` (the sub-
 * shapes, presentation, coercers + the generic `parseBlockList`). Unlike the singleton
 * landing builders (/boutique · /marques, which reorder a FIXED set of block keys via
 * `orderFromStored`), the homepage is an ORDERED ARRAY OF BLOCK
 * *INSTANCES*: the operator can add MANY blocks of the same type, each with its OWN config.
 *
 * STORAGE: one settings row `home.blocks` = a JSON array of {id, type, visible, config}.
 * Media are médiathèque ids; products/categories/brands are referenced by
 * slug/id and resolved against the catalog at render; hero slides by the banner module —
 * every link goes through its real source of truth, never inlined.
 *
 * Shared with the PAGES composer (page-blocks.ts) through block-model.ts. The generic core
 * is RE-EXPORTED below so existing `@/lib/pages/home-blocks` imports keep resolving.
 */

import { safeHref } from "@/lib/utils/safe-href";
import { clampInt, coerceEnum, coerceMediaId } from "./boutique-landing-parse";
import {
  asStr,
  parseBlockList,
  parseCard,
  parseHeader,
  parseImage,
  parsePresentation,
  parseRefs,
  parseSource,
  serializeBlocks,
  type Block,
  type BlockCard,
  type BlockHeader,
  type BlockImage,
  type BlockPresentation,
  type FaqItem,
  type ProductSource,
  type ProductSourceMode,
} from "./block-model";
import type { CollectionSlug } from "./collection-slugs";

// Re-export the shared surface-agnostic pieces so `@/lib/pages/home-blocks` stays a
// one-stop import for the home composer/renderer (no churn across existing callers).
export {
  BLOCK_ALIGNS,
  BLOCK_BACKGROUNDS,
  BLOCK_LIST_CAP,
  BLOCK_PADDINGS,
  BLOCK_WIDTHS,
  DEFAULT_PRESENTATION,
  IMAGE_RECO,
  PROMO_STRATEGIES,
  PRODUCT_SOURCE_MODES,
  EMPTY_HEADER,
  SECTION_CONTAINER,
  SECTION_GUTTER,
  SECTION_MAXW,
  newBlockId,
} from "./block-model";
export type {
  BlockCard,
  BlockHeader,
  BlockImage,
  BlockPresentation,
  FaqItem,
  ImageRecoKey,
  ProductSource,
  ProductSourceMode,
  PromoStrategy,
} from "./block-model";

// ── Block type catalog ──────────────────────────────────────────────────────
/** Every placeable homepage block. Adding one here + a case in the renderer + a
 *  config-form makes it available in the composer palette. Keep in sync with the
 *  admin palette labels (HOME_BLOCK_META). */
export const HOME_BLOCK_TYPES = [
  "hero", // full-bleed carousel — slides from CMS Bannières (placement home_hero)
  "product_rail", // horizontal scrolling product rail, filterable source
  "product_grid", // product grid, filterable source
  "banner", // one promotional banner (module row or inline), média
  "banner_duo", // two banners side-by-side
  "categories", // category chooser cards (root or picked) — boutique parity
  "brands", // brands — logos strip / featured vedette / A-Z index (variant) — marques parity
  "fifty_fifty", // light image+text cards (1–3)
  "editorial", // large image + text split
  "cta_band", // striking call-to-action band with image
  "feature_cards", // dark feature/complication cards
  "steps", // numbered "comment ça marche" step ladder
  "trust", // reassurance icon cards
  "rich_text", // heading + paragraph
  "faq", // question/answer accordion
  "testimonials", // customer pull-quotes / avis
  "stats", // a row of big figures + labels (brand facts)
  "spacer", // a pure vertical gap (optional hairline / ornament)
] as const;
export type HomeBlockType = (typeof HOME_BLOCK_TYPES)[number];

const HOME_BLOCK_TYPE_SET: ReadonlySet<string> = new Set(HOME_BLOCK_TYPES);

/** Palette metadata for the admin composer (label + one-line hint + group). */
export const HOME_BLOCK_META: Record<
  HomeBlockType,
  { label: string; hint: string; group: "produits" | "média" | "éditorial" | "catalogue" }
> = {
  hero: { label: "Héro (carrousel)", hint: "Grand carrousel plein écran — diapositives gérées dans Bannières", group: "média" },
  product_rail: { label: "Rail de produits", hint: "Bande horizontale filtrable (nouveautés, catégorie, marque, promo…)", group: "produits" },
  product_grid: { label: "Grille de produits", hint: "Grille filtrable de produits", group: "produits" },
  banner: { label: "Bannière", hint: "Une bannière promotionnelle (média + texte + CTA)", group: "média" },
  banner_duo: { label: "Duo de bannières", hint: "Deux bannières côte à côte", group: "média" },
  categories: { label: "Catégories", hint: "Cartes de catégories (mises en avant ou toutes)", group: "catalogue" },
  brands: { label: "Marques", hint: "Grille de marques en vedette (logos)", group: "catalogue" },
  fifty_fifty: { label: "Cartes 50/50", hint: "Cartes image + texte (1 à 3)", group: "éditorial" },
  editorial: { label: "Éditorial (split)", hint: "Grande image + texte côte à côte", group: "éditorial" },
  cta_band: { label: "Bandeau CTA", hint: "Bandeau d'appel à l'action avec image", group: "éditorial" },
  feature_cards: { label: "Cartes mises en avant", hint: "Cartes sombres (complications / focus produit)", group: "éditorial" },
  steps: { label: "Comment ça marche", hint: "Échelle d'étapes numérotées", group: "éditorial" },
  trust: { label: "Réassurance", hint: "Cartes icône + titre (confiance)", group: "éditorial" },
  rich_text: { label: "Texte", hint: "Titre + paragraphe", group: "éditorial" },
  faq: { label: "FAQ", hint: "Questions / réponses en accordéon", group: "éditorial" },
  testimonials: { label: "Témoignages", hint: "Citations clients (avis) en vedette", group: "éditorial" },
  stats: { label: "Chiffres clés", hint: "Rangée de chiffres + libellés (ex. « Depuis 1950 »)", group: "éditorial" },
  spacer: { label: "Espace", hint: "Un espace vertical (option : filet fin ou ornement)", group: "éditorial" },
};

/** spacer block options. */
export const SPACER_HEIGHTS = ["sm", "md", "lg", "xl"] as const;
export type SpacerHeight = (typeof SPACER_HEIGHTS)[number];
export const SPACER_ORNAMENTS = ["none", "rule", "mark"] as const;
export type SpacerOrnament = (typeof SPACER_ORNAMENTS)[number];

/** A customer testimonial / avis. */
export type Testimonial = { quote: string; author: string; meta: string; image: BlockImage | null };
/** A brand stat (« Depuis 1950 », « +500 modèles »). */
export type HomeStat = { value: string; label: string };

/** The per-type config union. Kept loose (every field optional-with-default) so a
 *  partially-filled block never throws — the renderer hides empty parts. */
export type HomeBlockConfig = {
  header?: BlockHeader;
  /** The heading's optional second line in the maison's italic GOLD (« Chaque seconde »
   *  / « est un souvenir. ») — same signature as the content pages. Every header-bearing
   *  block (not hero / banner_duo). When blank, a title typed over several lines (the
   *  editorial multi-line title) still gets its LAST line as the accent at render. */
  accent?: string;
  /** How the accent line is painted — « gold » (signature gold italic, default) or « ink »
   *  (a quiet second line in the title's own colour). Kept off the shape when « gold ». */
  accentStyle?: AccentStyle;
  /** The seam with the block ABOVE (home only). Absent = automatic (a very soft hairline;
   *  none under the hero carousel nor beside a photo/framed banner); "rule" = always a
   *  hairline; "join" = no hairline and no top spacing — continues the previous block's
   *  chapter (e.g. an editorial band and the step ladder under it). */
  separator?: "rule" | "join";
  /** Section personalisation. The home has ONE page ground: background, width and divider
   *  are normalised at parse; spacing (padding) and alignment are the operator's. */
  presentation?: BlockPresentation;
  /** listing blocks (product_rail / product_grid). */
  source?: ProductSource;
  count?: number;
  /** banner_duo ONLY: the two side-by-side image slots, as médiathèque ids picked in
   *  the composer (NOT banner-module rows — the name is historical). */
  bannerId?: string;
  bannerId2?: string;
  /** banner_duo: optional link per slot (absent = the image is not a link). */
  bannerHref?: string;
  bannerHref2?: string;
  image?: BlockImage | null;
  imageMobile?: BlockImage | null;
  /** editorial / cta_band: which side the image sits. */
  imageSide?: "left" | "right";
  body?: string;
  /** categories / brands: featured slugs ([] = all / auto). */
  refs?: string[];
  /** cards for fifty_fifty / feature_cards / trust. */
  cards?: BlockCard[];
  /** steps block: numbered "comment ça marche" items. */
  steps?: { title: string; body: string }[];
  /** faq items. */
  faq?: FaqItem[];
  /** testimonials block: customer pull-quotes / avis. */
  testimonials?: Testimonial[];
  /** stats block: brand figures + labels. */
  stats?: HomeStat[];
  /** spacer block: the vertical gap size + optional ornament. */
  spacerHeight?: SpacerHeight;
  spacerOrnament?: SpacerOrnament;
};

/** A placed home block instance. */
export type HomeBlock = Block<HomeBlockType, HomeBlockConfig>;

/** Block types that may go EDGE-TO-EDGE (full-viewport-width) on the home — the media-led
 *  banners. Everything else is locked to the canonical 1400 column (the one-ground contract). */
export const FULL_BLEED_CAPABLE: ReadonlySet<HomeBlockType> = new Set(["banner", "cta_band", "banner_duo"]);

// ── Parse / validate ─────────────────────────────────────────────────────────
/** Validate ONE block's config against its type — every field coerced, unknown dropped,
 *  plus the shared presentation wrapper. A missing/garbled field becomes its safe default;
 *  the renderer hides empty parts. Returns a clean config (never throws). */
export function parseBlockConfig(type: HomeBlockType, raw: unknown): HomeBlockConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  // The italic accent line — only for HEADER-BEARING types (not hero / banner_duo / spacer,
  // which have no heading), capped short (it is a heading fragment), and kept OFF the parsed
  // shape when blank so a stored layout without one round-trips byte-identical.
  const headerLess = type === "hero" || type === "banner_duo" || type === "spacer";
  const accent = headerLess ? "" : asStr(o.accent).slice(0, 160);
  // Gold (default) stays OFF the shape so a stored layout round-trips byte-identical.
  const accentStyle = coerceEnum(o.accentStyle, ACCENT_STYLES, "gold");
  // The accent that will ACTUALLY render is the explicit field OR the last line of a
  // multi-line title (heading() derives it). Gate accentStyle on that EFFECTIVE accent, not
  // just the explicit field, or an « ink » choice on a two-line title is silently dropped on
  // save (the composer shows + previews it, but the stored row would revert to gold). Forced
  // empty for header-less types so they never carry an orphan accentStyle.
  const effectiveAccent = headerLess ? "" : heading(asStr((o.header as Record<string, unknown> | undefined)?.title), accent).accent;
  // The seam with the block above — kept OFF the shape when automatic (round-trips byte-
  // identical, no migration). Meaningless on the hero (nothing sits above a carousel).
  const sep = type === "hero" ? "auto" : coerceEnum(o.separator, HOME_SEPARATORS, "auto");
  const pres = parsePresentation(o.presentation);
  return {
    ...parseBlockConfigBase(type, o),
    ...(accent ? { accent } : {}),
    ...(effectiveAccent && accentStyle !== "gold" ? { accentStyle } : {}),
    ...(sep !== "auto" ? { separator: sep } : {}),
    // ONE page ground on the home: no tone band, no kit full-bleed divider. Width stays the
    // canonical 1400 column EXCEPT the media-led banners, which may go « full » (edge-to-
    // edge). A flush full-bleed banner may also drop its padding. (The Pages keep all of these.)
    presentation: {
      ...pres,
      background: "default",
      divider: false,
      width: FULL_BLEED_CAPABLE.has(type) ? coerceEnum(pres.width, ["default", "full"] as const, "default") : "default",
      padding:
        pres.padding === "none"
          ? FULL_BLEED_CAPABLE.has(type) && pres.width === "full"
            ? "none"
            : "default"
          : pres.padding,
    },
  };
}

/** How the accent (second heading line) is painted: the maison's signature gold italic
 *  (default) or plain ink (a quiet second line). */
export const ACCENT_STYLES = ["gold", "ink"] as const;
export type AccentStyle = (typeof ACCENT_STYLES)[number];

/** Split a heading into its ink TEXT and its gold ACCENT. An explicit `accent` wins;
 *  otherwise a title typed over several lines gives its LAST line as the accent (legacy /
 *  hand-authored blocks). Pure — shared by the renderer AND the composer preview. */
export function heading(title: string | undefined, accent: string | undefined): { text: string; accent: string } {
  const lines = (title ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const a = (accent ?? "").trim();
  if (a) return { text: lines.join(" "), accent: a };
  if (lines.length >= 2) return { text: lines.slice(0, -1).join(" "), accent: lines[lines.length - 1] };
  return { text: lines[0] ?? "", accent: "" };
}

// ── Seams between sections ───────────────────────────────────────────────────
/** The per-block « Séparation » options (composer select). */
export const HOME_SEPARATORS = ["auto", "rule", "join"] as const;
/** What sits between two consecutively RENDERED home blocks. */
export type HomeSeam = "rule" | "space" | "join";

/**
 * The seam between two consecutively RENDERED blocks (pure; unit-tested):
 *  - under the hero carousel → space (never a line under the full-bleed photo);
 *  - the block asks to « Enchaîner » → join (no line, no top spacing);
 *  - the block asks for « Toujours un filet » → rule;
 *  - automatic: a media-led / framed neighbour (photo banner, banner duo, CTA panel) is its
 *    own boundary → space; otherwise a very soft hairline → rule.
 */
export function homeSeam(
  prev: { type: HomeBlockType; mediaLed: boolean },
  cur: { mediaLed: boolean; separator?: "rule" | "join" },
): HomeSeam {
  if (prev.type === "hero") return "space";
  if (cur.separator === "join") return "join";
  if (cur.separator === "rule") return "rule";
  return prev.mediaLed || cur.mediaLed ? "space" : "rule";
}

/**
 * Plan the seams for the blocks that ACTUALLY render, in order (pure; unit-tested). The
 * first rendered block gets `null` (nothing above it); a block that renders nothing is
 * skipped entirely, so it never leaves a double line; there is never a seam above the footer.
 */
export function planSeams(
  seq: ReadonlyArray<{ type: HomeBlockType; mediaLed: boolean; separator?: "rule" | "join"; renders: boolean }>,
): (HomeSeam | null)[] {
  let prev: { type: HomeBlockType; mediaLed: boolean } | null = null;
  return seq.map((b) => {
    if (!b.renders) return null;
    const seam = prev ? homeSeam(prev, b) : null;
    prev = { type: b.type, mediaLed: b.mediaLed };
    return seam;
  });
}

/** Starter config for a freshly added block (composer): the title the renderer used to
 *  hard-code as a fallback, now a real, editable (and clearable) value. */
export const HOME_BLOCK_SEED: Partial<Record<HomeBlockType, Record<string, unknown>>> = {
  product_rail: { header: { title: "Nouveautés" } },
  categories: { header: { title: "Catégories" } },
  brands: { header: { title: "Nos grandes marques" } },
  faq: { header: { title: "Questions fréquentes" } },
};

function parseBlockConfigBase(type: HomeBlockType, o: Record<string, unknown>): HomeBlockConfig {
  const header = parseHeader(o.header);
  switch (type) {
    case "hero":
      return { header };
    case "product_rail":
      return { header, source: parseSource(o.source), count: clampInt(o.count, 8, 2, 24) };
    case "product_grid":
      return { header, source: parseSource(o.source), count: clampInt(o.count, 8, 2, 24) };
    case "banner":
      return { header, image: parseImage(o.image), imageMobile: parseImage(o.imageMobile) };
    case "banner_duo": {
      // Optional per-slot link — blank stays OFF the shape (byte-identical round-trip).
      const h1 = asStr(o.bannerHref).trim();
      const h2 = asStr(o.bannerHref2).trim();
      return {
        bannerId: coerceMediaId(o.bannerId),
        bannerId2: coerceMediaId(o.bannerId2),
        ...(h1 ? { bannerHref: safeHref(h1) } : {}),
        ...(h2 ? { bannerHref2: safeHref(h2) } : {}),
      };
    }
    case "categories":
      return { header, refs: parseRefs(o.refs), count: clampInt(o.count, 12, 2, 40) };
    case "brands":
      return { header, refs: parseRefs(o.refs), count: clampInt(o.count, 12, 2, 40) };
    case "steps":
      return {
        header,
        steps: (Array.isArray(o.steps) ? o.steps : [])
          .map((x) => ({
            title: asStr((x as Record<string, unknown>)?.title),
            body: asStr((x as Record<string, unknown>)?.body),
          }))
          .filter((x) => x.title || x.body)
          .slice(0, 8),
      };
    case "fifty_fifty":
      return {
        header,
        cards: (Array.isArray(o.cards) ? o.cards : []).map(parseCard).slice(0, 3),
      };
    case "feature_cards":
      return {
        header,
        cards: (Array.isArray(o.cards) ? o.cards : []).map(parseCard).slice(0, 4),
      };
    case "trust":
      return {
        header,
        cards: (Array.isArray(o.cards) ? o.cards : []).map(parseCard).slice(0, 6),
      };
    case "editorial":
      return {
        header,
        image: parseImage(o.image),
        imageMobile: parseImage(o.imageMobile),
        imageSide: coerceEnum(o.imageSide, ["left", "right"] as const, "right"),
        body: asStr(o.body),
      };
    case "cta_band":
      return { header, image: parseImage(o.image), imageMobile: parseImage(o.imageMobile) };
    case "rich_text":
      return { header, body: asStr(o.body) };
    case "faq":
      return {
        header,
        faq: (Array.isArray(o.faq) ? o.faq : [])
          .map((x) => ({
            question: asStr((x as Record<string, unknown>)?.question),
            answer: asStr((x as Record<string, unknown>)?.answer),
          }))
          .filter((x) => x.question && x.answer)
          .slice(0, 30),
      };
    case "testimonials":
      return {
        header,
        testimonials: (Array.isArray(o.testimonials) ? o.testimonials : [])
          .map((x): Testimonial => {
            const r = (x ?? {}) as Record<string, unknown>;
            return { quote: asStr(r.quote), author: asStr(r.author), meta: asStr(r.meta), image: parseImage(r.image) };
          })
          .filter((x) => x.quote || x.author || x.image)
          .slice(0, 6),
      };
    case "stats":
      return {
        header,
        stats: (Array.isArray(o.stats) ? o.stats : [])
          .map((x): HomeStat => {
            const r = (x ?? {}) as Record<string, unknown>;
            return { value: asStr(r.value), label: asStr(r.label) };
          })
          .filter((x) => x.value || x.label)
          .slice(0, 4),
      };
    case "spacer":
      return {
        spacerHeight: coerceEnum(o.spacerHeight, SPACER_HEIGHTS, "md"),
        spacerOrnament: coerceEnum(o.spacerOrnament, SPACER_ORNAMENTS, "none"),
      };
    default:
      return { header };
  }
}

/**
 * Parse the stored `home.blocks` JSON into a clean, validated block list (drop unknown
 * types, coerce each config, stable ids, 40-block cap) via the shared generic parser.
 * Returns [] for absent OR garbled input (never throws). Note the READ path (getHomeBlocks)
 * branches on PRESENCE, so the legacy-synthesis fallback happens only when the row is ABSENT,
 * not when a present row fails to parse; the SAVE path (saveHomeBlocksAction) rejects a
 * present-but-unparseable payload up front so a garbled blob is never stored in the first place.
 */
export function parseHomeBlocks(raw: string | null | undefined): HomeBlock[] {
  return parseBlockList(
    raw,
    (t): t is HomeBlockType => HOME_BLOCK_TYPE_SET.has(t),
    parseBlockConfig,
  );
}

/** Serialise a home block list back to the stored JSON string (for the save action). */
export function serializeHomeBlocks(blocks: HomeBlock[]): string {
  return serializeBlocks(blocks);
}

// ── Listing « Voir tout » ────────────────────────────────────────────────────
/** The showcase page each ALGORITHMIC product source naturally continues into. */
export const SOURCE_SHOWCASE_SLUG: Partial<Record<ProductSourceMode, CollectionSlug>> = {
  new: "nouveautes",
  best_sellers: "top-ventes",
  on_promotion: "promotions",
};

/**
 * Where a rail/grid's « Voir tout » should lead when the operator left the block's own
 * CTA link blank: the showcase page for an algorithmic source (unless that page is
 * hidden — never link a 404), the category / brand / collection page for a scoped
 * source, nothing for a hand-picked list. Pure + isomorphic (unit-tested).
 */
export function sourceListingHref(
  source: ProductSource | undefined,
  hiddenShowcase: ReadonlySet<string>,
): string {
  if (!source) return "";
  const showcase = SOURCE_SHOWCASE_SLUG[source.mode];
  if (showcase) return hiddenShowcase.has(showcase) ? "" : `/${showcase}`;
  const ref = source.ref.trim();
  if (!ref) return "";
  // Categories and brands share the flat /[slug] namespace (see lib/links/link-target).
  if (source.mode === "category" || source.mode === "brand") return `/${encodeURIComponent(ref)}`;
  return "";
}
