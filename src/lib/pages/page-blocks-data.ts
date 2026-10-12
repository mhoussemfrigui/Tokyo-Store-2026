import "server-only";

import { inArray } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  cta_sections,
  hero_sections,
  stats_section_items,
  stats_sections,
  text_sections,
  timeline_section_items,
  timeline_sections,
} from "@/modules/cms/page/schema";
import { pageService } from "@/modules/cms/page/service";
import { mediaQueries, type ResolvedMedia } from "@/modules/media";
import { getSystemPageDefault } from "@/lib/legal/system-page-content";
import { listProductsForSource } from "@/lib/api/products";
import { listNavBrands } from "@/lib/api/brands";
import { listCategories } from "@/lib/api/categories";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { deliveryService } from "@/modules/delivery";
import { listActiveBrands } from "@/modules/catalog/brand/queries";
import type { Product } from "@/types/catalog";
import {
  newBlockId,
  parsePageBlocks,
  type PageBlock,
  type PageBlockConfig,
} from "./page-blocks";
import { EMPTY_HEADER } from "./block-model";

/**
 * Server reader + resolver for the PAGE block composer. A page's content is read in this
 * priority (mirrors the old LegalPageRenderer fallback chain, so nothing ever blanks):
 *   1. the stored `pages.blocks` JSON (the composer layout), when non-empty;
 *   2. otherwise SYNTHESISE blocks from the legacy `page_sections` (non-destructive
 *      rollover — the page renders identically until an operator saves in the composer);
 *   3. otherwise, for a SYSTEM legal slug, synthesise a rich_text block from the built-in
 *      default HTML (cgv/cgu/privacy/cookies/mentions-legales stay live out of the box);
 *   4. otherwise, no blocks (the renderer shows a neutral placeholder).
 * `resolvePageBlocks` then resolves media ids + catalogue data in batched round-trips.
 */

export type PageMeta = {
  slug: string;
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  ogImageMediaId: string | null;
  canonicalUrl: string | null;
  noindex: boolean;
};

export type PageForRender = { page: PageMeta; blocks: PageBlock[] };

function pageMeta(page: {
  slug: string;
  title: string;
  meta_title: string | null;
  meta_description: string | null;
  og_image_media_id: string | null;
  canonical_url: string | null;
  noindex: boolean;
}): PageMeta {
  return {
    slug: page.slug,
    title: page.title,
    metaTitle: page.meta_title,
    metaDescription: page.meta_description,
    ogImageMediaId: page.og_image_media_id,
    canonicalUrl: page.canonical_url,
    noindex: page.noindex,
  };
}

const img = (mediaId: string | null): { mediaId: string; alt: string } | null =>
  mediaId ? { mediaId, alt: "" } : null;

/**
 * Non-destructively synthesise blocks from the legacy relational sections (media IDS, not
 * URLs — resolvePageBlocks resolves them uniformly). Ordered by display_order, visible only.
 */
async function synthesizeFromSections(pageId: string): Promise<PageBlock[]> {
  const sections = (await pageService.listSectionsForPage(pageId)).filter((s) => s.is_visible);
  if (sections.length === 0) return [];
  const ids = sections.map((s) => s.id);

  const [heroes, texts, ctas, statsParents, statsItems, tlParents, tlItems] = await Promise.all([
    db.select().from(hero_sections).where(inArray(hero_sections.page_section_id, ids)),
    db.select().from(text_sections).where(inArray(text_sections.page_section_id, ids)),
    db.select().from(cta_sections).where(inArray(cta_sections.page_section_id, ids)),
    db.select().from(stats_sections).where(inArray(stats_sections.page_section_id, ids)),
    db.select().from(stats_section_items).where(inArray(stats_section_items.stats_section_id, ids)),
    db.select().from(timeline_sections).where(inArray(timeline_sections.page_section_id, ids)),
    db.select().from(timeline_section_items).where(inArray(timeline_section_items.timeline_section_id, ids)),
  ]);
  const heroBy = new Map(heroes.map((h) => [h.page_section_id, h]));
  const textBy = new Map(texts.map((t) => [t.page_section_id, t]));
  const ctaBy = new Map(ctas.map((c) => [c.page_section_id, c]));
  const statsBy = new Map(statsParents.map((s) => [s.page_section_id, s]));
  const tlBy = new Map(tlParents.map((t) => [t.page_section_id, t]));
  const statsKids = new Map<string, typeof statsItems>();
  for (const it of statsItems) (statsKids.get(it.stats_section_id) ?? statsKids.set(it.stats_section_id, []).get(it.stats_section_id)!).push(it);
  const tlKids = new Map<string, typeof tlItems>();
  for (const it of tlItems) (tlKids.get(it.timeline_section_id) ?? tlKids.set(it.timeline_section_id, []).get(it.timeline_section_id)!).push(it);

  const blocks: PageBlock[] = [];
  const push = (type: PageBlock["type"], config: PageBlockConfig) =>
    blocks.push({ id: newBlockId(), type, visible: true, config });

  for (const s of sections) {
    switch (s.type) {
      case "hero": {
        const h = heroBy.get(s.id);
        if (!h) break;
        push("hero", {
          header: {
            eyebrow: h.eyebrow ?? "",
            title: h.title,
            subtitle: h.subtitle ?? "",
            ctaLabel: h.primary_cta_label ?? "",
            ctaHref: h.primary_cta_href ?? "",
          },
          body: h.description ?? "",
          image: img(h.image_media_id),
          imageMobile: null,
          secondaryCtaLabel: h.secondary_cta_label ?? "",
          secondaryCtaHref: h.secondary_cta_href ?? "",
        });
        break;
      }
      case "text": {
        const t = textBy.get(s.id);
        if (!t) break;
        push("rich_text", {
          header: { ...EMPTY_HEADER, title: t.heading ?? "" },
          body: t.body,
          alignment: (t.alignment as "left" | "center" | "right") ?? "left",
        });
        break;
      }
      case "cta": {
        const c = ctaBy.get(s.id);
        if (!c) break;
        push("cta_band", {
          header: {
            ...EMPTY_HEADER,
            title: c.title,
            subtitle: c.description ?? "",
            ctaLabel: c.primary_cta_label,
            ctaHref: c.primary_cta_href,
          },
          image: img(c.background_image_media_id),
          imageMobile: null,
          style: (c.style as "dark" | "light" | "brand") ?? "dark",
        });
        break;
      }
      case "stats": {
        const st = statsBy.get(s.id);
        if (!st) break;
        const items = (statsKids.get(s.id) ?? []).sort((a, b) => a.display_order - b.display_order);
        push("stats", {
          header: { ...EMPTY_HEADER, title: st.heading ?? "" },
          layout: (st.layout as "grid" | "row") ?? "grid",
          stats: items.map((i) => ({ label: i.label, value: i.value, caption: i.caption ?? "", source: "manual" as const, since: "" })),
        });
        break;
      }
      case "timeline": {
        const tl = tlBy.get(s.id);
        if (!tl) break;
        const items = (tlKids.get(s.id) ?? []).sort((a, b) => a.display_order - b.display_order);
        push("timeline", {
          header: { ...EMPTY_HEADER, title: tl.heading ?? "" },
          timeline: items.map((i) => ({ year: i.year, title: i.title, description: i.description ?? "" })),
        });
        break;
      }
      // product_list / banner_grid are dormant legacy enum values with no data — skip.
    }
  }
  return blocks;
}

/** A SYSTEM legal slug's built-in default HTML → one rich_text block, so cgv/cgu/privacy/
 *  cookies/mentions-legales render out of the box even before the DB page is populated. */
function systemDefaultBlocks(slug: string): PageBlock[] {
  const def = getSystemPageDefault(slug);
  if (!def) return [];
  return [
    {
      id: newBlockId(),
      type: "rich_text",
      visible: true,
      config: {
        header: { eyebrow: "", title: "", subtitle: "", ctaLabel: "", ctaHref: "" },
        body: def.html,
        alignment: "left",
      },
    },
  ];
}

/**
 * The page's render title (published DB title, else the system default title, else the
 * slug) + its block list, following the non-destructive fallback chain. Returns null only
 * when the slug is neither a published page nor a known system default.
 */
export async function getPageForRender(slug: string): Promise<PageForRender | null> {
  const page = await pageService.findBySlug(slug).catch(() => null);
  const def = getSystemPageDefault(slug);

  // Unpublished / missing: a system slug still renders its built-in default (never blank).
  if (!page || !page.is_published) {
    if (!def) return null;
    return {
      page: {
        slug,
        title: page?.title ?? def.title,
        metaTitle: page?.meta_title ?? null,
        metaDescription: page?.meta_description ?? null,
        ogImageMediaId: page?.og_image_media_id ?? null,
        canonicalUrl: page?.canonical_url ?? null,
        noindex: page?.noindex ?? false,
      },
      blocks: systemDefaultBlocks(slug),
    };
  }

  // Published. A NON-NULL blocks column is authoritative — even "[]" (an operator who
  // deliberately cleared the composer): we must NOT resurrect the legacy sections they
  // removed. Only a NULL column (a page never saved in the composer) synthesises from the
  // legacy page_sections. For a system legal slug, an empty result still falls back to the
  // built-in default HTML so the legal text is never blank; a custom slug honours the clear.
  let blocks: PageBlock[];
  if (page.blocks != null) {
    blocks = parsePageBlocks(page.blocks);
    if (blocks.length === 0) blocks = systemDefaultBlocks(slug); // [] for a non-system slug → honours the clear
  } else {
    // Guard the legacy-sections read: a DB hiccup here must degrade to the system default (or
    // []), never 500 a content/legal page.
    const synth = await synthesizeFromSections(page.id).catch(() => []);
    blocks = synth.length > 0 ? synth : systemDefaultBlocks(slug);
  }
  return { page: pageMeta(page), blocks };
}

/**
 * Blocks to show in the ADMIN composer for a page (regardless of published state): the
 * stored composer layout, else a synthesis of the legacy sections, else the system default.
 * The operator edits these; saving writes them to pages.blocks (converting a legacy page).
 */
export async function getEditBlocks(page: { id: string; slug: string; blocks: string | null }): Promise<PageBlock[]> {
  // A non-null column is authoritative (show exactly what was saved, incl. an empty list);
  // only a never-saved page (NULL) is seeded from the legacy sections / system default.
  if (page.blocks != null) return parsePageBlocks(page.blocks);
  const synth = await synthesizeFromSections(page.id).catch(() => []);
  return synth.length > 0 ? synth : systemDefaultBlocks(page.slug);
}

// ── Data resolution for the renderer ──────────────────────────────────────────
/** The « Identité & contact » values the backend-linked blocks read (contact_channels,
 *  stores phone fallback, jobs apply e-mail). Edited at /admin/cms/settings. */
export type PageSiteContact = {
  name: string;
  phone: string;
  whatsapp: string;
  email: string;
  hours: string;
  address: string;
  /** Central HQ / registered address + its front-end visibility flag (shown in the
   *  contact block only when public). Distinct from the retail store addresses. */
  hqAddress: string;
  hqAddressPublic: boolean;
};
/** A live pickup location (« Retrait en boutique », /admin/system/delivery) a store card
 *  can be linked to — its values win over the card's own copy. */
export type PagePickup = {
  name: string;
  address: string;
  city: string;
  phone: string;
  hours: string;
  enabled: boolean;
};

export type ResolvedPage = {
  page: PageMeta;
  blocks: PageBlock[];
  media: Map<string, ResolvedMedia>;
  productsByBlock: Map<string, Product[]>;
  brands: Awaited<ReturnType<typeof listNavBrands>>;
  categories: Awaited<ReturnType<typeof listCategories>>;
  /** Contact settings (empty strings when unset / not needed by any visible block). */
  site: PageSiteContact;
  /** Linked pickup locations by id (only fetched when a visible stores card links one). */
  pickups: Map<string, PagePickup>;
  /** Live count of active brands (only when a visible stats item asks for it). */
  brandCount: number | null;
};

const EMPTY_SITE: PageSiteContact = { name: "", phone: "", whatsapp: "", email: "", hours: "", address: "", hqAddress: "", hqAddressPublic: false };

/** Resolve everything a page's blocks need: every image through the médiathèque in ONE
 *  round-trip, each listing block's products, the shared catalogue lists, and the backend
 *  data the linked blocks read (contact settings, pickup locations, live brand count) —
 *  fetched once and shared. Only what a VISIBLE block needs is queried. Degrades to empty. */
export async function resolvePageBlocks(forRender: PageForRender): Promise<ResolvedPage> {
  const { page, blocks } = forRender;
  const live = blocks.filter((b) => b.visible);
  const mediaIds = new Set<string>();
  for (const b of live) {
    const c = b.config;
    if (c.image?.mediaId) mediaIds.add(c.image.mediaId);
    if (c.imageMobile?.mediaId) mediaIds.add(c.imageMobile.mediaId);
    for (const im of c.images ?? []) if (im?.mediaId) mediaIds.add(im.mediaId);
    for (const card of c.cards ?? []) if (card.image?.mediaId) mediaIds.add(card.image.mediaId);
    for (const s of c.stores ?? []) if (s.image?.mediaId) mediaIds.add(s.image.mediaId);
  }
  const visible = (t: PageBlock["type"]) => live.some((b) => b.type === t);
  const listingBlocks = live.filter((b) => b.type === "product_grid" && b.config.source);
  const needsSite = visible("contact_channels") || visible("stores") || visible("jobs");
  const pickupIds = [
    ...new Set(
      live
        .filter((b) => b.type === "stores")
        .flatMap((b) => (b.config.stores ?? []).map((s) => s.pickupLocationId))
        .filter(Boolean),
    ),
  ];
  const needsBrandCount = live.some(
    (b) => b.type === "stats" && (b.config.stats ?? []).some((s) => s.source === "brands"),
  );

  const [brands, categories, productLists, settings, pickupRows, activeBrands] = await Promise.all([
    visible("brands") ? listNavBrands().catch(() => []) : Promise.resolve([]),
    visible("categories") ? listCategories().catch(() => []) : Promise.resolve([]),
    Promise.all(
      listingBlocks.map((b) =>
        listProductsForSource(b.config.source!, b.config.count ?? 8).catch(() => [] as Product[]),
      ),
    ),
    needsSite
      ? getSettingsMap().catch(() => ({}) as Record<string, string | null>)
      : Promise.resolve({} as Record<string, string | null>),
    pickupIds.length
      ? deliveryService.listPickups({ includeDisabled: true }).catch(() => [])
      : Promise.resolve([]),
    needsBrandCount ? listActiveBrands().catch(() => null) : Promise.resolve(null),
  ]);
  for (const cat of categories) {
    if (cat.boutiqueImageMediaId) mediaIds.add(cat.boutiqueImageMediaId);
    if (cat.iconMediaId) mediaIds.add(cat.iconMediaId);
  }

  const media = mediaIds.size
    ? await mediaQueries
        .resolveUrlAltMap([...mediaIds])
        .catch(() => new Map<string, ResolvedMedia>())
    : new Map<string, ResolvedMedia>();

  const productsByBlock = new Map<string, Product[]>();
  listingBlocks.forEach((b, i) => productsByBlock.set(b.id, productLists[i] ?? []));

  const s = (k: string) => (settings[k] ?? "").trim();
  const site: PageSiteContact = needsSite
    ? {
        name: s("site.name"),
        phone: s("site.contact_phone"),
        whatsapp: s("site.whatsapp"),
        email: s("site.contact_email"),
        hours: s("site.hours"),
        address: s("site.address"),
        hqAddress: s("business.hq_address"),
        hqAddressPublic: s("business.hq_address_public") === "true",
      }
    : EMPTY_SITE;

  const wanted = new Set(pickupIds);
  const pickups = new Map<string, PagePickup>();
  for (const r of pickupRows) {
    if (!wanted.has(r.id)) continue;
    pickups.set(r.id, {
      name: r.name ?? "",
      address: r.address_line ?? "",
      city: r.city ?? "",
      phone: r.phone ?? "",
      hours: r.hours_label ?? "",
      enabled: r.enabled,
    });
  }

  return {
    page,
    blocks,
    media,
    productsByBlock,
    brands,
    categories,
    site,
    pickups,
    brandCount: activeBrands ? activeBrands.length : null,
  };
}
