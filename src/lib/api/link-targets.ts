import "server-only";

import { categoryQueries } from "@/modules/catalog/category";
import { categoryService } from "@/modules/catalog/category/service";
import { buildCategoryChain } from "@/lib/catalog/category-chain";
import { brandService } from "@/modules/catalog/brand/service";
import { pageService } from "@/modules/cms/page/service";
import { SYSTEM_PAGES } from "@/lib/links/link-target";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { asBool } from "@/lib/cms/setting-coerce";

/**
 * Option lists for the admin LinkTargetPicker (promo chips + nav items).
 * `value` is the target slug; `label` is the human name. Degrades gracefully —
 * any failing source resolves to an empty list rather than 500ing the admin.
 */
export type LinkTargetOption = { value: string; label: string };
export type LinkTargets = {
  systemPages: LinkTargetOption[];
  categories: LinkTargetOption[];
  brands: LinkTargetOption[];
  pages: LinkTargetOption[];
};

export async function listLinkTargets(): Promise<LinkTargets> {
  const [categories, brands, pages, settings] = await Promise.all([
    categoryService.listAll().catch(() => []),
    // Uncapped `listAll()` twins (not `list({ limit: 500 })`): a capped list
    // truncated a >500-row catalogue BEFORE the `is_active` filter below, so
    // alphabetically-late (or display-order-late) targets were never offered.
    brandService.listAll().catch(() => []),
    pageService.listAll().catch(() => []),
    // Showcase visibility lives in site_settings (pages.<slug>.visible). Fail OPEN
    // (offer every system page) on a read error, so a settings outage never blanks
    // the link picker.
    getSettingsMap().catch(() => ({}) as Record<string, string | null>),
  ]);
  // Only storefront-visible categories — the row AND its whole live ancestor
  // chain active (`isCategoryChainActive`, the /[slug] resolver's rule). An
  // inactive category, or an active child of an inactive parent, 404s, so it
  // is not offered (soft-deleted rows are already excluded by listAll).
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  return {
    // System pages = the 3 showcase slugs. A hidden one (pages.<slug>.visible=false)
    // 404s, so it is NOT offered — mirroring the is_published / is_active guards below.
    systemPages: SYSTEM_PAGES.filter((p) =>
      asBool(settings[`pages.${p.slug}.visible`], true),
    ).map((p) => ({ value: p.slug, label: p.label })),
    categories: categories
      .filter((c) =>
        categoryQueries.isCategoryChainActive(buildCategoryChain(c.id, categoryById)),
      )
      .map((c) => ({ value: c.slug, label: c.name })),
    // Only active brands render at /[slug]; offering an inactive brand would
    // produce a 404 link (mirrors the `is_published` page guard below).
    brands: brands.filter((b) => b.is_active).map((b) => ({ value: b.slug, label: b.name })),
    // Only published pages render at /[slug]; offering an unpublished page would
    // produce a 404 link.
    pages: pages.filter((p) => p.is_published).map((p) => ({ value: p.slug, label: p.title })),
  };
}
