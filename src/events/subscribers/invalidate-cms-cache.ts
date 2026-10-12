import "server-only";

import { bus } from "../bus";
import { CACHE_TAGS, cacheTag } from "@/lib/cache/tags";
import { bustCacheTag as bust } from "@/lib/cache/revalidate";

/**
 * Cache-tag invalidator for the CMS surface (banners, settings,
 * FAQs, navigation, pages). Tag strings come from the single
 * `@/lib/cache/tags` vocabulary so the emit + consume sides can't drift.
 * `bustCacheTag` expires the tag immediately (see that helper for why the
 * Next-16 `(tag, "default")` form would only mark it stale).
 *
 * Only the `site:settings` bust has a reader today (the /api/track consent
 * gate's `unstable_cache`). The banner/FAQ/nav/page tags are RESERVED — no
 * cached read declares them yet, so those busts are forward-wiring no-ops and
 * CMS freshness on the storefront comes from the writers' `revalidatePath`.
 */

export function registerCmsCacheSubscriber() {
  // ── Banners — placement-specific tags so the home hero / header strip
  //    / category grid / footer / checkout banners invalidate independently.
  bus.on("banner.created", ({ payload }) => {
    bust(CACHE_TAGS.banners);
    bust(cacheTag.bannersPlacement(payload.placement));
  });
  bus.on("banner.updated", ({ payload }) => {
    bust(CACHE_TAGS.banners);
    bust(cacheTag.bannersPlacement(payload.placement));
  });
  bus.on("banner.deleted", ({ payload }) => {
    bust(CACHE_TAGS.banners);
    bust(cacheTag.bannersPlacement(payload.placement));
  });

  // ── Settings — refreshes the /api/track consent-gate read (the only cached
  //    settings reader; layout consumers read the map per request).
  bus.on("setting.upserted", () => bust(CACHE_TAGS.settings));

  // ── FAQs — scope-keyed (help, product:<id>, category:<id>, brand:<id>). The
  // bulk upsert workflows emit `faq.updated` (replace-in-place covers add/edit/drop).
  bus.on("faq.updated", ({ payload }) => {
    bust(CACHE_TAGS.faqs);
    bust(cacheTag.faqsScope(payload.scope));
  });

  // ── Navigation — menus rebuild the relevant footer/header column.
  bus.on("nav.menu.created", ({ payload }) => {
    bust(CACHE_TAGS.nav);
    bust(cacheTag.navKey(payload.key));
  });
  bus.on("nav.menu.updated", ({ payload }) => {
    bust(CACHE_TAGS.nav);
    bust(cacheTag.navKey(payload.key));
  });
  // (nav.menu.deleted removed — no menu-delete surface ever emits it.)
  bus.on("nav.item.created", ({ payload }) => {
    bust(CACHE_TAGS.nav);
    bust(cacheTag.navMenu(payload.menuId));
  });
  bus.on("nav.item.updated", ({ payload }) => {
    bust(CACHE_TAGS.nav);
    bust(cacheTag.navMenu(payload.menuId));
  });
  bus.on("nav.item.deleted", () => bust(CACHE_TAGS.nav));

  // ── CMS pages — slug-specific.
  bus.on("page.created", ({ payload }) => {
    bust(CACHE_TAGS.pages);
    bust(cacheTag.pageSlug(payload.slug));
  });
  bus.on("page.published", ({ payload }) => {
    bust(CACHE_TAGS.pages);
    bust(cacheTag.pageSlug(payload.slug));
  });
  bus.on("page.unpublished", ({ payload }) => {
    bust(CACHE_TAGS.pages);
    bust(cacheTag.pageSlug(payload.slug));
  });
  bus.on("page.deleted", () => bust(CACHE_TAGS.pages));
  // Page-level fields (title / slug / SEO meta). A slug rename's OLD slug tag is
  // covered by the broad `pages` bust.
  bus.on("page.updated", ({ payload }) => {
    bust(CACHE_TAGS.pages);
    bust(cacheTag.pageSlug(payload.slug));
  });
  // Section edits are by far the most common page mutation. The event carries
  // `pageId` — resolve to a slug-keyed bust by looking up the page on demand.
  bus.on("page.section.changed", async ({ payload }) => {
    bust(CACHE_TAGS.pages);
    // Defensive: never run a uuid lookup on an empty id (it just errors).
    if (!payload.pageId) return;
    try {
      const { pageService } = await import("@/modules/cms/page/service");
      const page = await pageService.findById(payload.pageId);
      if (page) bust(cacheTag.pageSlug(page.slug));
    } catch {
      // Subscribers must never throw; broad `pages` tag has been busted
      // already so the storefront still picks up the change on next read.
    }
  });
}
