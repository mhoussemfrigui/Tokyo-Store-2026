import "server-only";

import { pageService } from "./service";

/**
 * Page READ helpers.
 *
 * Page bodies are read through the block pipeline (`getPageForRender` in
 * `@/lib/pages/page-blocks-data`), which every storefront surface (`/[slug]`,
 * `LegalPageRenderer`, `/help`, `/md`) shares. The only query that still lives here
 * is the sitemap's slug list.
 */

/** Every published, indexable CMS page (slug + freshness) for the sitemap — deduped there by URL. */
export async function listPublishedCustomPageSlugs() {
  return pageService.listPublishedCustomPageSlugs();
}

/** {slug, noindex, isPublished} for non-deleted pages — lets the sitemap gate the hardcoded
 *  file-routed system entries on `!noindex && (isPublished || has-system-default)`. */
export async function listPageStates() {
  return pageService.listPageStates();
}
