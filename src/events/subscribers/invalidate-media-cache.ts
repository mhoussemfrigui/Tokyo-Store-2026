import "server-only";

import { bus } from "../bus";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { bustCacheTag as bust } from "@/lib/cache/revalidate";

/**
 * Cache-tag invalidator for MEDIA metadata + settings changes AND deletes.
 *
 * `'use cache'` storefront reads bake the resolveMediaUrl-resolved `/cdn/<key>`
 * URL + the media `alt` into their cached output — the PDP DTO (gallery, variant
 * images, og:image, JSON-LD image) and the /blog listing (featured image). So a
 * change to a media's `alt` / `url_override` (media.updated), a store-wide CDN
 * base change (media.settings_updated → every resolved URL shifts), or a delete
 * previously only revalidated the ADMIN routes, and a cached storefront page kept
 * serving the old URL/alt until an UNRELATED edit busted its tag. The
 * reprocess-détourage job already busts product caches; this closes the
 * metadata + settings + delete paths.
 *
 * Media edits are infrequent admin operations and a media id can be referenced
 * by any of products / categories / brands / collections / CMS pages / blog
 * posts, so we bust the storefront LIST tags broadly rather than run a per-owner
 * reverse lookup — correctness over surgical precision on a rare event.
 * `bustCacheTag` expires the tag immediately (see that helper) and is
 * idempotent, so the Médiathèque bulk delete (one media.deleted per row + one
 * media.bulk_deleted) costs only a few cheap tag writes per row.
 */
export function registerMediaCacheSubscriber() {
  const bustStorefrontMedia = () => {
    bust(CACHE_TAGS.productsList);
    bust(CACHE_TAGS.categories);
    bust(CACHE_TAGS.brands);
    bust(CACHE_TAGS.pages);
    bust(CACHE_TAGS.blogPosts);
  };
  // alt / url_override edit → the resolved URL or alt baked into cached HTML moved.
  bus.on("media.updated", bustStorefrontMedia);
  // cdn_base_url (and other media settings) → a store-wide URL rewrite.
  bus.on("media.settings_updated", bustStorefrontMedia);
  // A delete can remove a still-referenced media and its objects are purged
  // right away → cached pages would point at a now-404 object; bust so they
  // re-resolve to the placeholder/fallback. `media.deleted` is what the
  // Médiathèque single AND bulk delete emit per row (the workflow's event);
  // `media.bulk_deleted` comes from the bulk action's summary emit and the
  // data-job clean segments (hard delete).
  bus.on("media.deleted", bustStorefrontMedia);
  bus.on("media.bulk_deleted", bustStorefrontMedia);
}
