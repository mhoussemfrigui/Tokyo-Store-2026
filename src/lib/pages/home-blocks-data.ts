import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { getHomePageConfig, type HomePageConfig } from "./home-page-config";
import {
  parseHomeBlocks,
  newBlockId,
  SOURCE_SHOWCASE_SLUG,
  type HomeBlock,
  type BlockCard,
} from "./home-blocks";
import { asBool, EMPTY_HEADER } from "./block-model";
import { COLLECTION_SLUGS } from "./collection-slugs";
import { listProductsForSource } from "@/lib/api/products";
import { listHomeHeroSlides, type HeroSlide as DbHeroSlide } from "@/lib/api/cms";
import { mediaQueries, type ResolvedMedia } from "@/modules/media";
import { listNavBrands } from "@/lib/api/brands";
import { listCategories } from "@/lib/api/categories";
import type { Product } from "@/types/catalog";

/**
 * Server reader for the HOME block composer. Reads the stored `home.blocks` JSON and
 * parses it; when it is ABSENT (the composer has never been saved) it SYNTHESISES the
 * current 8-section home from the live `home.*` settings — so the storefront homepage
 * is byte-for-byte unchanged until an operator edits it in the new composer (a
 * non-destructive rollover, no migration write). Once the composer saves, `home.blocks`
 * wins and the legacy `home.*` keys become dormant.
 *
 * Data resolution (products per listing block, médiathèque URLs, hero slides) lives in
 * the storefront loader alongside the renderer; this module only produces the ordered,
 * validated BLOCK LIST.
 */

const HOME_BLOCKS_KEY = "home.blocks";

/** Get the composed home blocks: the stored list, or the synthesised legacy default.
 *
 *  Branch on PRESENCE, not length: an ABSENT `home.blocks` row means "never configured"
 *  → reproduce today's home from the legacy `home.*` config (non-destructive rollover). A
 *  PRESENT row — even one the operator deliberately emptied to `[]` — is their layout and
 *  wins verbatim (an empty home, not a silent revert to the legacy 8-section page). */
export async function getHomeBlocks(): Promise<HomeBlock[]> {
  let raw: string | null = null;
  try {
    const s = await getSettingsMap();
    raw = s[HOME_BLOCKS_KEY] ?? null;
  } catch {
    raw = null;
  }
  if (raw !== null) return parseHomeBlocks(raw);
  // No composer layout yet → reproduce today's home from the live home.* config.
  const config = await getHomePageConfig().catch(() => null);
  return config ? synthesizeLegacyHomeBlocks(config) : [];
}

/** True when a composer layout has been SAVED (the `home.blocks` row exists), vs the
 *  synthesised legacy one. Lets the admin panel tell "you're editing the new layout" from
 *  "seeded from legacy" — and a saved-but-empty layout still counts as the operator's. */
export async function hasStoredHomeBlocks(): Promise<boolean> {
  try {
    const s = await getSettingsMap();
    return (s[HOME_BLOCKS_KEY] ?? null) !== null;
  } catch {
    return false;
  }
}

/**
 * Map the legacy HomePageConfig (the fixed 8 sections) to composer blocks, preserving
 * order + content + per-section visibility. Images carry their médiathèque id; copy is
 * moved verbatim. This is what an operator first sees in the composer — fully editable,
 * reorderable, and a faithful 1:1 of the current storefront home.
 */
export function synthesizeLegacyHomeBlocks(config: HomePageConfig): HomeBlock[] {
  const blocks: HomeBlock[] = [];
  const push = (b: Omit<HomeBlock, "id">) => blocks.push({ id: newBlockId(), ...b });

  const img = (mediaId: string) => (mediaId ? { mediaId, alt: "" } : null);
  // The legacy 3-line editorial title maps onto the composer's EXPLICIT fields: lines 1-2 are
  // the ink title, line 3 is the gold « Accent » — so the operator sees a real, labelled,
  // editable Accent field (not an invisible last-line side-effect). Mirrors the appointment /
  // complications branches below.
  const editorialTitle = (c: { titleLine1: string; titleLine2: string }) =>
    [c.titleLine1, c.titleLine2].filter(Boolean).join("\n");

  // 1) Hero carousel (slides live in CMS Bannières, placement home_hero).
  push({ type: "hero", visible: config.hero.visible, config: { header: { ...EMPTY_HEADER } } });

  // 2) Nouveautés rail.
  push({
    type: "product_rail",
    visible: config.rails.newArrivals.visible,
    config: {
      header: {
        eyebrow: config.rails.newArrivals.label,
        title: config.rails.newArrivals.title,
        subtitle: config.rails.newArrivals.subtitle,
        ctaLabel: "",
        ctaHref: "",
      },
      source: source("new"),
      count: 8,
    },
  });

  // 3) FiftyFifty — light image+text cards.
  push({
    type: "fifty_fifty",
    visible: config.fiftyfifty.visible,
    config: {
      header: { ...EMPTY_HEADER },
      cards: config.fiftyfifty.cards.map(
        (c): BlockCard => ({
          eyebrow: c.label,
          title: c.title,
          body: c.desc,
          meta: "",
          ctaLabel: "",
          ctaHref: c.href,
          image: img(c.imageMediaId),
          icon: "",
        }),
      ),
    },
  });

  // 4) Appointment → CTA band with image.
  push({
    type: "cta_band",
    visible: config.appointment.visible,
    config: {
      header: {
        eyebrow: config.appointment.eyebrow,
        title: config.appointment.title,
        subtitle: config.appointment.description,
        ctaLabel: "",
        ctaHref: config.appointment.href,
      },
      // The legacy two-tone title maps onto the composer's italic accent line.
      ...(config.appointment.titleAccent ? { accent: config.appointment.titleAccent } : {}),
      image: img(config.appointment.imageMediaId),
      imageMobile: null,
    },
  });

  // 5) Complications → dark feature cards.
  push({
    type: "feature_cards",
    visible: config.complications.visible,
    config: {
      header: {
        eyebrow: config.complications.label,
        title: config.complications.title,
        subtitle: "",
        ctaLabel: "",
        ctaHref: "",
      },
      ...(config.complications.titleAccent ? { accent: config.complications.titleAccent } : {}),
      cards: config.complications.cards.map(
        (c): BlockCard => ({
          eyebrow: c.tag,
          title: c.title,
          body: c.desc,
          meta: c.price,
          ctaLabel: "",
          ctaHref: c.href,
          image: img(c.imageMediaId),
          icon: "",
        }),
      ),
    },
  });

  // 6) Meilleures Ventes rail (top sellers).
  push({
    type: "product_rail",
    visible: config.rails.promotions.visible,
    config: {
      header: {
        eyebrow: config.rails.promotions.label,
        title: config.rails.promotions.title,
        subtitle: config.rails.promotions.subtitle,
        ctaLabel: "",
        ctaHref: "",
      },
      source: source("best_sellers"),
      count: 8,
    },
  });

  // 7) Heritage editorial (text left / image right).
  push({
    type: "editorial",
    visible: config.heritage.visible,
    config: {
      header: {
        eyebrow: config.heritage.eyebrow,
        title: editorialTitle(config.heritage),
        subtitle: "",
        ctaLabel: config.heritage.ctaLabel,
        ctaHref: config.heritage.ctaHref,
      },
      ...(config.heritage.titleLine3 ? { accent: config.heritage.titleLine3 } : {}),
      body: config.heritage.description,
      image: img(config.heritage.imageMediaId),
      imageSide: "right",
    },
  });

  return blocks;
}

// ── Data resolution for the storefront renderer ──────────────────────────────
export type ResolvedHome = {
  blocks: HomeBlock[];
  /** médiathèque id → resolved {url, alt} — every BLOCK-level image (block/mobile, card,
   *  testimonial avatar, category tile) resolved in ONE round-trip. Hero slides
   *  (listHomeHeroSlides) and brand logos (listNavBrands) carry their own URLs from their
   *  own queries, so they are not in this map. */
  media: Map<string, ResolvedMedia>;
  /** block id → its loaded products (listing blocks only). */
  productsByBlock: Map<string, Product[]>;
  heroSlides: DbHeroSlide[];
  brands: Awaited<ReturnType<typeof listNavBrands>>;
  categories: Awaited<ReturnType<typeof listCategories>>;
  /** Showcase slugs (nouveautes / top-ventes / promotions) that are hidden — a rail's
   *  derived « Voir tout » never links one (see sourceListingHref). */
  hiddenShowcase: ReadonlySet<string>;
};

/**
 * Resolve everything the composed home needs to render, batched: every block image
 * through the médiathèque in ONE call, each listing block's products via the unified
 * source loader (enriched), and the shared catalogue lists (brands / categories)
 * fetched ONCE and shared across blocks. Only the lists a visible block actually needs
 * are queried. Every read degrades to empty on failure so a single dead block never
 * 500s the homepage.
 */
export async function resolveHomeBlocks(blocks: HomeBlock[]): Promise<ResolvedHome> {
  // Media ids known from the block configs themselves: a block's desktop/mobile
  // image, each card's image, and the two banner_duo slots (bannerId/bannerId2 are
  // médiathèque ids picked in the composer, NOT banner-module rows).
  const mediaIds = new Set<string>();
  for (const b of blocks) {
    // Only blocks that will actually render — a hidden block's images must not be fetched
    // from the médiathèque on every request (the renderer skips them anyway).
    if (!b.visible) continue;
    const c = b.config;
    if (c.image?.mediaId) mediaIds.add(c.image.mediaId);
    if (c.imageMobile?.mediaId) mediaIds.add(c.imageMobile.mediaId);
    if (c.bannerId) mediaIds.add(c.bannerId);
    if (c.bannerId2) mediaIds.add(c.bannerId2);
    for (const card of c.cards ?? []) if (card.image?.mediaId) mediaIds.add(card.image.mediaId);
    for (const t of c.testimonials ?? []) if (t.image?.mediaId) mediaIds.add(t.image.mediaId);
  }
  // NB: banner_duo slot links (bannerHref/bannerHref2) are plain hrefs — nothing to resolve.
  const visible = (t: HomeBlock["type"]) => blocks.some((b) => b.type === t && b.visible);
  const listingBlocks = blocks.filter(
    (b) => (b.type === "product_rail" || b.type === "product_grid") && b.visible && b.config.source,
  );

  // Fetch the shared catalogue lists + each listing block's products first. The
  // categories block renders its OWN image (category.boutiqueImageMediaId) through the
  // same media map, so those ids aren't known until the lists come back — hence media
  // resolution waits for this round (one extra hop, acceptable on the force-dynamic
  // homepage; everything still degrades to empty).
  const [heroSlides, brands, categories, productLists] = await Promise.all([
    visible("hero") ? listHomeHeroSlides().catch(() => []) : Promise.resolve([] as DbHeroSlide[]),
    visible("brands") ? listNavBrands().catch(() => []) : Promise.resolve([]),
    visible("categories") ? listCategories().catch(() => []) : Promise.resolve([]),
    Promise.all(
      listingBlocks.map((b) =>
        listProductsForSource(b.config.source!, b.config.count ?? 8).catch(() => [] as Product[]),
      ),
    ),
  ]);

  // The category tile shows the « Image boutique » (as on /boutique) — never the small
  // listing chip icon blown up to 4:5; unset ⇒ the typographic panel.
  for (const cat of categories) if (cat.boutiqueImageMediaId) mediaIds.add(cat.boutiqueImageMediaId);

  const media = mediaIds.size
    ? await mediaQueries
        .resolveUrlAltMap([...mediaIds])
        .catch(() => new Map<string, ResolvedMedia>())
    : new Map<string, ResolvedMedia>();

  const productsByBlock = new Map<string, Product[]>();
  listingBlocks.forEach((b, i) => productsByBlock.set(b.id, productLists[i] ?? []));

  // Showcase pages a listing's derived « Voir tout » must NOT point at (hidden → 404).
  // Only read when a visible listing block uses an algorithmic source; getSettingsMap is
  // React-cached per request (getHomeBlocks already paid for it). Fail CLOSED: when the
  // settings can't be read, treat every showcase as hidden so no link can 404.
  const hiddenShowcase = new Set<string>();
  if (listingBlocks.some((b) => SOURCE_SHOWCASE_SLUG[b.config.source!.mode])) {
    const s = await getSettingsMap().catch(() => null);
    for (const slug of COLLECTION_SLUGS) {
      if (!s || !asBool(s[`pages.${slug}.visible`], true)) hiddenShowcase.add(slug);
    }
  }

  return { blocks, media, productsByBlock, heroSlides, brands, categories, hiddenShowcase };
}
function source(mode: "new" | "best_sellers") {
  return { mode, ref: "", productIds: [], windowDays: 30, promoStrategy: "both" as const };
}
