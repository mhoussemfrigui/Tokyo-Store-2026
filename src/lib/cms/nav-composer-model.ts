/**
 * Composable mega-menu model — the admin-editable structure of a nav root's
 * dropdown (CMS → Nav Menu). Isomorphic + client-safe (pure string/JSON logic,
 * no DB, no server-only) so the admin builder (edit), the storefront resolver
 * (read) and the tests all share ONE contract — mirroring `block-model.ts`.
 *
 * A nav ROOT is a `main`-menu `nav_items` row (label / href / icon / order /
 * visibility already columns). Its DROPDOWN composition lives in the row's
 * `config` JSONB as a `NavDropdown`. A root with no dropdown (or an empty one)
 * renders as a plain top-level link — exactly today's `main`-item behaviour.
 *
 * LAYOUT is explicit: a dropdown is an ORDERED LIST OF COLUMNS (1–4, left→right)
 * and each column holds its own ordered blocks, so an operator decides exactly
 * what each column shows. An `image` block alone in a column renders as the tall
 * featured panel (the classic look). A list block (links/categories/brands/
 * collections) can set `maxPerColumn` to wrap a long list into sub-columns
 * (column-major: fill down to the cap, then overflow into the next sub-column).
 *
 * Storage is tolerant: the parser never throws and drops anything malformed, and
 * it also upgrades the LEGACY `{ columns:number, blocks:[] }` shape in place, so a
 * hand-edited / older blob degrades gracefully instead of blanking the header.
 * Média ids live inside this JSON, so `nav_items.config` is tracked by a matcher
 * in all three media-reference seams (see modules/media/queries.ts).
 */

// ─── Link target (mirrors LinkTargetInput in lib/links/link-target.ts) ───────
export type NavLinkRef = {
  label: string;
  icon?: string | null;
  /** Manual URL (wins over kind/ref); else the internal target below. */
  href?: string | null;
  /** url | system | category | brand | page | product */
  kind?: string | null;
  ref?: string | null;
  newTab?: boolean;
};

// ─── Slot — WHERE a root renders in the crimson header ───────────────────────
/**
 * A root's placement in the header. `mega` roots are the universes of the
 * « Catégories » mega-menu (rail + panel). `shortcut` roots are the centre quick-
 * link pills. `service` roots are the mobile menu's « Service client » links.
 * Stored in the root's `config` (not a DB column) so the builder can group them
 * without a schema change; defaults to `mega`.
 */
export const NAV_SLOTS = ["mega", "shortcut", "service"] as const;
export type NavSlot = (typeof NAV_SLOTS)[number];
export const DEFAULT_NAV_SLOT: NavSlot = "mega";
export const NAV_SLOT_META: Record<NavSlot, { label: string; hint: string }> = {
  mega: { label: "Univers (méga-menu)", hint: "Un grand univers du menu « Catégories » : rail + panneau de sous-catégories, image et produits." },
  shortcut: { label: "Raccourci (pastille)", hint: "Une pastille de raccourci au centre de la barre (ex. Bons plans)." },
  service: { label: "Service client (mobile)", hint: "Un lien du bloc « Service client » en bas du menu mobile." },
};

// ─── Block types ─────────────────────────────────────────────────────────────
export const NAV_BLOCK_TYPES = [
  "taxonomy",
  "links",
  "categories",
  "brands",
  "products",
  "image",
] as const;
export type NavBlockType = (typeof NAV_BLOCK_TYPES)[number];

export const BRAND_DISPLAYS = ["titles", "logos", "both"] as const;
export type BrandDisplay = (typeof BRAND_DISPLAYS)[number];

/** Featured-image panel FORMAT — the operator picks the shape that matches both
 *  their source image and the menu length, so `object-cover` fills it without
 *  cropping (shortest → tallest). See NAV_IMAGE_ASPECT_META for labels + reco
 *  source dimensions, and NAV_ASPECT_CLASS in site-header for the CSS ratio. */
export const NAV_IMAGE_ASPECTS = ["landscape", "square", "portrait", "long", "longer"] as const;
export type NavImageAspect = (typeof NAV_IMAGE_ASPECTS)[number];
export const DEFAULT_NAV_IMAGE_ASPECT: NavImageAspect = "portrait";
/** Per-format admin label + recommended SOURCE dimensions (the on-screen panel is
 *  340 px wide). Upload a source matching the chosen ratio ⇒ never cropped. */
export const NAV_IMAGE_ASPECT_META: Record<NavImageAspect, { label: string; reco: string }> = {
  landscape: { label: "Paysage (4:3)", reco: "Paysage 4:3 — 900×680 px (panneau 340×255)" },
  square: { label: "Carré (1:1)", reco: "Carré 1:1 — 800×800 px (panneau 340×340)" },
  portrait: { label: "Portrait (3:4)", reco: "Portrait 3:4 — 680×900 px (panneau 340×453)" },
  long: { label: "Long (2:3)", reco: "Long 2:3 — 680×1020 px (panneau 340×510)" },
  longer: { label: "Très long (9:16)", reco: "Très long 9:16 — 680×1210 px (panneau 340×604)" },
};

export const PRODUCT_SOURCES = ["category", "new_arrivals", "best_sellers", "on_promotion", "pins"] as const;
export type ProductSource = (typeof PRODUCT_SOURCES)[number];

/**
 * Relative SIZE scale for the VISUAL blocks (products preview, brand logos,
 * collection cards, and the image panel's width) — the analogue of the image
 * `aspect`, letting an operator make each bigger or smaller. The renderer
 * (site-header) maps it to each block's NATURAL dimension: grid density for the
 * product + collection-card grids, logo height for brand logos, panel width for
 * the image. `md` is the current (default) look everywhere, so an unset value
 * renders exactly as before. Keep the per-block CSS maps in site-header in sync.
 */
export const NAV_BLOCK_SIZES = ["sm", "md", "lg"] as const;
export type NavBlockSize = (typeof NAV_BLOCK_SIZES)[number];
export const DEFAULT_NAV_BLOCK_SIZE: NavBlockSize = "md";
export const NAV_BLOCK_SIZE_META: Record<NavBlockSize, { label: string }> = {
  sm: { label: "Petit" },
  md: { label: "Moyen" },
  lg: { label: "Grand" },
};

/**
 * AUTO sub-category sections — expands a universe's category sub-tree into the
 * mega-menu's titled chip columns (level-2 children with grandchildren → a titled
 * section of grandchild chips; leaf children → one trailing untitled section).
 * `categorySlug` picks which universe to expand; when unset the resolver uses the
 * ROOT's own category target, so a universe root linked to `category:telephonie`
 * auto-fills from Téléphonie with zero config. Stays in sync with the catalog —
 * the HYBRID default; swap it for curated `links` sections to override a universe.
 */
export type NavTaxonomyBlock = { type: "taxonomy"; title?: string; categorySlug?: string; maxPerColumn?: number };
/** A manual list of links (categories/pages/brands/custom URLs), each live-checked. */
export type NavLinksBlock = { type: "links"; title?: string; links: NavLinkRef[]; maxPerColumn?: number };
/** Auto list of the site's root categories (chip links). */
export type NavCategoriesBlock = { type: "categories"; title?: string; limit?: number; maxPerColumn?: number };
/** Auto list of active brands — as titles, logos, or both. `size` scales the
 *  logo tiles (logos/both displays only). */
export type NavBrandsBlock = { type: "brands"; title?: string; display: BrandDisplay; limit?: number; maxPerColumn?: number; size?: NavBlockSize };
/** A small product preview — a dynamic source or manual pins (product IDs).
 *  `size` scales the preview tiles (grid density). */
export type NavProductsBlock = {
  type: "products";
  title?: string;
  source: ProductSource;
  /** Manual pins are product IDs (not slugs) — used only when source==="pins". */
  pins?: string[];
  /** Category slug — used only when source==="category". When unset the resolver
   *  falls back to the owning ROOT's category target (a universe shows its own
   *  products with zero config — the default per-universe preview). */
  categoryRef?: string;
  count?: number;
  size?: NavBlockSize;
};
/** A médiathèque image panel (the featured image), with optional copy + target. */
export type NavImageBlock = {
  type: "image";
  mediaId?: string | null;
  mediaMobileId?: string | null;
  eyebrow?: string;
  title?: string;
  href?: string | null;
  kind?: string | null;
  ref?: string | null;
  /** Panel format — picks the CSS aspect ratio so the source fills without crop. */
  aspect?: NavImageAspect;
  /** Panel WIDTH scale (the aspect fixes the shape, this fixes how wide it is). */
  size?: NavBlockSize;
  /** Show this heavy featured image in the mobile menu. Default FALSE (opt-in). */
  showOnMobile?: boolean;
};

export type NavBlock =
  | NavTaxonomyBlock
  | NavLinksBlock
  | NavCategoriesBlock
  | NavBrandsBlock
  | NavProductsBlock
  | NavImageBlock;

/** Which block types support the `maxPerColumn` wrap (the list-ish blocks). The
 *  `taxonomy` block auto-lays its sections out (no manual wrap), so it is NOT one. */
const NAV_LIST_BLOCK_TYPES: readonly NavBlockType[] = ["links", "categories", "brands"];
export function isListBlockType(t: string): boolean {
  return (NAV_LIST_BLOCK_TYPES as readonly string[]).includes(t);
}

/** One column of a dropdown — an ordered stack of blocks. */
export type NavColumn = { blocks: NavBlock[] };

/** The dropdown composition of a nav root: explicit columns (left→right). */
export type NavDropdown = {
  /** Whether this root's dropdown content shows in the mobile menu. */
  mobileVisible: boolean;
  columns: NavColumn[];
};

/** The full `config` JSONB of a root `nav_items` row. `slot` places the root in
 *  the header (mega universe / shortcut pill / mobile service link), `blurb` is a
 *  universe's one-line tagline, `accent` flags a shortcut pill as the crimson
 *  « Bons plans »-style accent. */
export type NavRootConfig = {
  dropdown: NavDropdown | null;
  slot?: NavSlot;
  blurb?: string | null;
  accent?: boolean;
};

/** A stable client/editor id (react keys in the admin builder) — so reordering
 *  or deleting a root/column/block preserves each stateful child (MediaPicker,
 *  toggles) instead of desyncing by array index. Not persisted. */
export function navUid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Math.random().toString(36).slice(2)}`;
  }
}

export const MAX_NAV_COLUMNS = 4;
export const NAV_PRODUCTS_MAX = 6;

// ─── Tolerant parsing (read path — never throws, drops malformed) ─────────────
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function trimOrNull(v: unknown): string | null {
  const s = str(v).trim();
  return s ? s : null;
}
function clampInt(v: unknown, lo: number, hi: number, fb: number): number {
  if (v == null) return fb; // null/undefined → the documented default (NOT 0→lo)
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fb;
  return Math.min(Math.max(n, lo), hi);
}
/** Optional positive-int field (limit / maxPerColumn): undefined when unset. A
 *  value below the minimum (0, negative, blank) reads as UNSET — a limit of 0
 *  means "no cap", not "clamp up to 1". Values above the max clamp down. */
function optInt(v: unknown, lo: number, hi: number): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < lo) return undefined;
  return Math.min(n, hi);
}
function asOneOf<T extends string>(v: unknown, allowed: readonly T[], fb: T): T {
  const s = str(v).trim().toLowerCase();
  return (allowed as readonly string[]).includes(s) ? (s as T) : fb;
}

function parseLinkRef(raw: unknown): NavLinkRef | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const label = str(r.label).trim();
  const href = trimOrNull(r.href);
  const ref = trimOrNull(r.ref);
  // A link needs a label and SOME target (manual href or an internal ref).
  if (!label || (!href && !ref)) return null;
  return {
    label,
    icon: trimOrNull(r.icon),
    href,
    kind: trimOrNull(r.kind),
    ref,
    newTab: r.newTab === true,
  };
}

function parseBlock(raw: unknown): NavBlock | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const type = str(r.type).trim();
  const title = trimOrNull(r.title) ?? undefined;
  const maxPerColumn = optInt(r.maxPerColumn, 1, 30);
  switch (type) {
    case "taxonomy":
      return { type: "taxonomy", title, categorySlug: trimOrNull(r.categorySlug) ?? undefined, maxPerColumn };
    case "links": {
      const links = Array.isArray(r.links)
        ? r.links.map(parseLinkRef).filter((l): l is NavLinkRef => l !== null)
        : [];
      if (links.length === 0) return null;
      return { type: "links", title, links, maxPerColumn };
    }
    case "categories":
      return { type: "categories", title, limit: optInt(r.limit, 1, 24), maxPerColumn };
    case "brands":
      return {
        type: "brands",
        title,
        display: asOneOf(r.display, BRAND_DISPLAYS, "titles"),
        limit: optInt(r.limit, 1, 60),
        maxPerColumn,
        size: asOneOf(r.size, NAV_BLOCK_SIZES, DEFAULT_NAV_BLOCK_SIZE),
      };
    case "products": {
      const source = asOneOf(r.source, PRODUCT_SOURCES, "new_arrivals");
      const pins = Array.isArray(r.pins)
        ? r.pins.map((p) => str(p).trim()).filter(Boolean).slice(0, NAV_PRODUCTS_MAX)
        : [];
      return {
        type: "products",
        title,
        source,
        pins: source === "pins" ? pins : undefined,
        categoryRef: source === "category" ? (trimOrNull(r.categoryRef) ?? undefined) : undefined,
        count: clampInt(r.count, 1, NAV_PRODUCTS_MAX, 4),
        size: asOneOf(r.size, NAV_BLOCK_SIZES, DEFAULT_NAV_BLOCK_SIZE),
      };
    }
    case "image": {
      // An image with no média is nothing to show (resolver drops it anyway, and
      // the builder never saves one) — drop it here so it can't make a phantom
      // empty column. Symmetric with blockToConfig in the builder.
      const mediaId = trimOrNull(r.mediaId);
      if (!mediaId) return null;
      return {
        type: "image",
        mediaId,
        mediaMobileId: trimOrNull(r.mediaMobileId),
        eyebrow: trimOrNull(r.eyebrow) ?? undefined,
        title: trimOrNull(r.title) ?? undefined,
        href: trimOrNull(r.href),
        kind: trimOrNull(r.kind),
        ref: trimOrNull(r.ref),
        aspect: asOneOf(r.aspect, NAV_IMAGE_ASPECTS, DEFAULT_NAV_IMAGE_ASPECT),
        size: asOneOf(r.size, NAV_BLOCK_SIZES, DEFAULT_NAV_BLOCK_SIZE),
        // Default FALSE: the featured image is a heavy visual, hidden on mobile
        // unless the operator opts in (matches the seed + builder default).
        showOnMobile: r.showOnMobile === true,
      };
    }
    default:
      return null;
  }
}

function parseColumn(raw: unknown): NavColumn | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const blocks = Array.isArray(r.blocks)
    ? r.blocks.map(parseBlock).filter((b): b is NavBlock => b !== null)
    : [];
  if (blocks.length === 0) return null;
  return { blocks };
}

/**
 * Parse a nav root's `config` (a JSON string or already-parsed object) into a
 * `NavDropdown`, or null when there is no (valid) dropdown. Tolerant: unknown
 * blocks are dropped, bad values fall back, never throws. Also UPGRADES the
 * legacy `{ columns:number, blocks:[] }` shape: its non-image blocks become the
 * first column and each image block its own trailing column (so a featured image
 * keeps rendering as a side panel).
 */
export function parseNavDropdown(raw: string | null | undefined | Record<string, unknown>): NavDropdown | null {
  if (!raw) return null;
  let obj: Record<string, unknown>;
  try {
    obj = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : raw;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  // Accept either { dropdown: {...} } or a bare dropdown object.
  const d = (obj.dropdown ?? obj) as Record<string, unknown>;
  if (!d || typeof d !== "object") return null;
  const mobileVisible = d.mobileVisible !== false;

  // New shape: columns is an array of { blocks }.
  if (Array.isArray(d.columns)) {
    const parsed = d.columns.map(parseColumn).filter((c): c is NavColumn => c !== null);
    const columns = normalizeColumns(parsed);
    if (columns.length === 0) return null;
    return { mobileVisible, columns };
  }

  // Legacy shape: { columns:number, blocks:[] } → one column of all blocks, then
  // normalized (content kept together, each image split into its own column).
  if (Array.isArray(d.blocks)) {
    const blocks = d.blocks.map(parseBlock).filter((b): b is NavBlock => b !== null);
    const columns = normalizeColumns([{ blocks }]);
    if (columns.length === 0) return null;
    return { mobileVisible, columns };
  }

  return null;
}

/**
 * Enforce the render contract that an IMAGE is always a SOLE-image column — the
 * desktop mega-menu only paints an image when it is alone in its column (a
 * DropdownBlock renders nothing for an image). An image dropped beside content
 * blocks, or two images in one column, would be invisible on desktop (yet show on
 * mobile, which flattens). Normalizing here — at the single parse point every read
 * goes through (resolver, admin loader, AND the save action) — heals both new
 * saves and already-stored mixed columns. PER COLUMN (so separate content columns
 * stay separate): a column's non-image blocks stay together as one column, then
 * each image becomes its own column right after. Capped at MAX_NAV_COLUMNS.
 */
function normalizeColumns(columns: NavColumn[]): NavColumn[] {
  const out: NavColumn[] = [];
  for (const col of columns) {
    const content = col.blocks.filter((b) => b.type !== "image");
    const images = col.blocks.filter((b): b is NavImageBlock => b.type === "image");
    if (content.length > 0) out.push({ blocks: content });
    for (const img of images) out.push({ blocks: [img] });
  }
  return out.slice(0, MAX_NAV_COLUMNS);
}

/**
 * Parse a root's full `config` → its dropdown + header placement. Tolerant (never
 * throws): a legacy config (bare dropdown, or `{dropdown}` with no slot) reads as
 * a `mega` universe with no blurb/accent, so existing roots are unchanged.
 */
export function parseNavRootConfig(
  raw: string | null | undefined | Record<string, unknown>,
): { dropdown: NavDropdown | null; slot: NavSlot; blurb: string | null; accent: boolean } {
  const dropdown = parseNavDropdown(raw);
  let obj: Record<string, unknown> | null = null;
  if (raw) {
    try {
      obj = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : raw;
    } catch {
      obj = null;
    }
  }
  return {
    dropdown,
    slot: asOneOf(obj?.slot, NAV_SLOTS, DEFAULT_NAV_SLOT),
    blurb: trimOrNull(obj?.blurb),
    accent: obj?.accent === true,
  };
}

/** Serialize a dropdown + header placement back to the stored `config` shape.
 *  Omits default/blank extras so a plain `mega` root stays a lean `{dropdown}`. */
export function serializeNavConfig(
  dropdown: NavDropdown | null,
  extras?: { slot?: NavSlot; blurb?: string | null; accent?: boolean },
): NavRootConfig {
  const cfg: NavRootConfig = { dropdown };
  if (extras?.slot && extras.slot !== DEFAULT_NAV_SLOT) cfg.slot = extras.slot;
  const blurb = extras?.blurb?.trim();
  if (blurb) cfg.blurb = blurb;
  if (extras?.accent) cfg.accent = true;
  return cfg;
}

/** Flatten a dropdown's blocks across all columns (order-preserving). */
export function dropdownBlocks(dropdown: NavDropdown | null): NavBlock[] {
  return (dropdown?.columns ?? []).flatMap((c) => c.blocks);
}

/**
 * Split a list into column-major sub-columns of at most `size` items each — fill
 * the first sub-column top-to-bottom, then overflow into the next. `size`
 * undefined / < 1, or a list that fits, → a single sub-column. (The storefront
 * renders a list block's items this way when it sets `maxPerColumn`.)
 */
export function chunkColumns<T>(items: T[], size?: number): T[][] {
  if (!size || size < 1 || items.length <= size) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ─── Resolved render DTO (server resolver → SiteHeader) ──────────────────────
// The server turns the stored config + the live catalog/média into these plain,
// client-safe shapes; the header renders them with no further data access.
export type ResolvedNavItem = {
  label: string;
  href: string;
  icon?: string | null;
  /** Logo (brands) URL, when the display needs one. */
  imageUrl?: string | null;
  newTab?: boolean;
};
export type ResolvedNavProduct = {
  name: string;
  href: string;
  imageUrl: string | null;
  /** Current price + a genuine compare-at (null when none) — the crimson preview
   *  row shows the price and a strike. Both are plain numbers (client-safe). */
  price: number;
  oldPrice: number | null;
};
/** One auto-generated sub-category section (title + chip items) — the resolved
 *  shape a `taxonomy` block (or a manual `links` block) contributes to a universe
 *  panel. `href` is the section-title's shelf (null → plain-text heading). */
export type ResolvedNavSection = { title?: string; href: string | null; items: ResolvedNavItem[] };
export type ResolvedNavBlock =
  | { type: "taxonomy"; title?: string; maxPerColumn?: number; sections: ResolvedNavSection[] }
  | { type: "links"; title?: string; maxPerColumn?: number; items: ResolvedNavItem[] }
  | { type: "categories"; title?: string; maxPerColumn?: number; items: ResolvedNavItem[] }
  | { type: "brands"; title?: string; display: BrandDisplay; maxPerColumn?: number; size: NavBlockSize; items: ResolvedNavItem[] }
  | { type: "products"; title?: string; size: NavBlockSize; items: ResolvedNavProduct[] }
  | {
      type: "image";
      imageUrl: string;
      imageMobileUrl?: string | null;
      imageAlt?: string;
      eyebrow?: string;
      title?: string;
      href: string;
      aspect: NavImageAspect;
      size: NavBlockSize;
      showOnMobile: boolean;
    };
/** One resolved dropdown column — its render-ready blocks. */
export type ResolvedNavColumn = { blocks: ResolvedNavBlock[] };
export type ResolvedNavRoot = {
  /** Stable key (the nav_item id, or a default-root slug) for react keys. */
  key: string;
  label: string;
  href: string;
  icon?: string | null;
  newTab?: boolean;
  mobileVisible: boolean;
  /** Header placement: mega universe / shortcut pill / mobile service link. */
  slot: NavSlot;
  /** A universe's one-line tagline (mega slot) — the blurb under its name. */
  blurb?: string | null;
  /** A shortcut pill's crimson accent flag (shortcut slot). */
  accent?: boolean;
  /** Empty → a plain top-level link (no dropdown). */
  columns: ResolvedNavColumn[];
};


// ─── Auto taxonomy sections (the `taxonomy` block's structure) ───────────────
/** A category tree node the resolver expands a `taxonomy` block from — the
 *  storefront's bundled taxonomy shape (slug / name / children). */
export type NavTaxoNode = { slug: string; name: string; children?: NavTaxoNode[] };

/**
 * Expand a universe node into the mega-menu's titled sub-category sections — the
 * AUTO structure a `taxonomy` block produces. Level-2 children WITH grandchildren
 * become a titled section (title links to the child, chips are the grandchildren);
 * leaf level-2 children gather into ONE trailing untitled section. PURE + mirrors
 * the storefront's former `buildMega`, so the builder-driven menu reproduces the
 * hardcoded taxonomy layout exactly. Shared by the resolver and its tests.
 */
export function taxonomySections(node: NavTaxoNode): ResolvedNavSection[] {
  const children = node.children ?? [];
  const sections: ResolvedNavSection[] = [];
  const leaves: NavTaxoNode[] = [];
  for (const c of children) {
    const grandchildren = c.children ?? [];
    if (grandchildren.length > 0) {
      sections.push({
        title: c.name,
        href: `/${c.slug}`,
        items: grandchildren.map((g) => ({ label: g.name, href: `/${g.slug}` })),
      });
    } else {
      leaves.push(c);
    }
  }
  if (leaves.length > 0) {
    sections.push({ href: null, items: leaves.map((l) => ({ label: l.name, href: `/${l.slug}` })) });
  }
  return sections;
}

/** Every média id referenced inside a dropdown (image blocks) — for the admin
 *  média pre-resolve and any reference audit. */
export function navDropdownMediaIds(dropdown: NavDropdown | null): string[] {
  const ids: string[] = [];
  for (const b of dropdownBlocks(dropdown)) {
    if (b.type === "image") {
      if (b.mediaId) ids.push(b.mediaId);
      if (b.mediaMobileId) ids.push(b.mediaMobileId);
    }
  }
  return ids;
}
