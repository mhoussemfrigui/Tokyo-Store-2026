import "server-only";

import { bannerService } from "./service";

export const listHomeHeroSlides = () => bannerService.listLive("home_hero");
export const listHeaderStripBanners = () => bannerService.listLive("header_strip");
export const listFooterBanners = () => bannerService.listLive("footer");
// The `nav_*` featured-banner reader (listNavFeaturedBanners) was removed with
// the composable nav rebuild: the mega-menu now reads its imagery from
// nav_items.config image blocks, not the nav_* banner placements.
// NB: the untargeted `listCategoryGridBanners` reader was removed in P5 — the
// storefront resolves in-grid banners through the targeting-aware
// `listGridBannersForListing` below (via lib/api/cms.ts `listCategoryGridBanners`).
/** Targeting-aware category_grid banners for a specific listing (P5). */
export const listGridBannersForListing = (
  opts: Parameters<typeof bannerService.listGridBannersForListing>[0],
) => bannerService.listGridBannersForListing(opts);
