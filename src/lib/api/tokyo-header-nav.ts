import "server-only";

import { cache } from "react";

import { getMainNavRoots } from "@/lib/api/main-nav-items";
import type { ResolvedNavBlock, ResolvedNavRoot } from "@/lib/cms/nav-composer-model";
import {
  EMPTY_HEADER_NAV,
  type NavMenuBanner,
  type NavMenuProduct,
  type NavMenuSection,
  type NavServiceLink,
  type NavShortcut,
  type NavUniverse,
  type TokyoHeaderNav,
} from "@/storefront/lib/header-nav-model";

/**
 * The crimson header's nav, mapped from the resolved nav builder (`getMainNavRoots`,
 * request-cached + shared with the legacy header / home JSON-LD) into plain DTOs
 * for `<Header>`. Groups roots by SLOT: `mega` → « Catégories » universes (their
 * taxonomy/links blocks become the panel's titled sections, a products block the
 * preview row, an image block the banner), `shortcut` → centre pills, `service` →
 * mobile « Service client » links. No data access of its own — pure mapping.
 */

const blocksOf = (root: ResolvedNavRoot): ResolvedNavBlock[] => root.columns.flatMap((c) => c.blocks);

/** Universe panel sections: a `taxonomy` block contributes its auto sub-category
 *  sections; a curated `links` / `categories` block contributes one section. */
function sectionsFromBlocks(blocks: ResolvedNavBlock[]): NavMenuSection[] {
  const out: NavMenuSection[] = [];
  for (const b of blocks) {
    if (b.type === "taxonomy") {
      for (const s of b.sections) {
        out.push({ title: s.title, href: s.href, items: s.items.map((i) => ({ label: i.label, href: i.href, newTab: i.newTab })) });
      }
    } else if (b.type === "links" || b.type === "categories") {
      out.push({ title: b.title, href: null, items: b.items.map((i) => ({ label: i.label, href: i.href, newTab: i.newTab })) });
    }
    // brands → not shown in the universe panel; products → preview row; image → banner.
  }
  return out;
}

/** The universe's « Produits populaires » preview row (first products block). */
function productsFromBlocks(blocks: ResolvedNavBlock[]): NavMenuProduct[] {
  const p = blocks.find((b): b is Extract<ResolvedNavBlock, { type: "products" }> => b.type === "products");
  if (!p) return [];
  return p.items.map((it) => ({
    slug: it.href.replace(/^\//, ""),
    title: it.name,
    image: it.imageUrl,
    price: it.price,
    oldPrice: it.oldPrice,
  }));
}

/** The universe's featured banner (first image block). */
function bannerFromBlocks(blocks: ResolvedNavBlock[]): NavMenuBanner | null {
  const img = blocks.find((b): b is Extract<ResolvedNavBlock, { type: "image" }> => b.type === "image");
  if (!img) return null;
  return {
    imageUrl: img.imageUrl,
    imageMobileUrl: img.imageMobileUrl ?? null,
    alt: img.imageAlt ?? img.title ?? "",
    eyebrow: img.eyebrow,
    title: img.title,
    href: img.href,
    aspect: img.aspect,
    size: img.size,
    showOnMobile: img.showOnMobile,
  };
}

export const getTokyoHeaderNav = cache(async function getTokyoHeaderNav(): Promise<TokyoHeaderNav> {
  let roots: ResolvedNavRoot[];
  try {
    roots = await getMainNavRoots();
  } catch {
    return EMPTY_HEADER_NAV;
  }
  const universes: NavUniverse[] = [];
  const shortcuts: NavShortcut[] = [];
  const service: NavServiceLink[] = [];
  for (const r of roots) {
    if (r.slot === "shortcut") {
      shortcuts.push({ label: r.label, href: r.href, icon: r.icon ?? null, accent: r.accent ?? false });
    } else if (r.slot === "service") {
      service.push({ label: r.label, href: r.href });
    } else {
      const blocks = blocksOf(r);
      universes.push({
        key: r.key,
        label: r.label,
        blurb: r.blurb ?? "",
        icon: r.icon ?? null,
        href: r.href,
        sections: sectionsFromBlocks(blocks),
        products: productsFromBlocks(blocks),
        banner: bannerFromBlocks(blocks),
      });
    }
  }
  return { universes, shortcuts, service };
});
