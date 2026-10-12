import "server-only";

import { bus } from "../bus";
import { CACHE_TAGS, cacheTag } from "@/lib/cache/tags";
import { bustCacheTag as bust } from "@/lib/cache/revalidate";
import { bustStorefrontCache } from "@/lib/cache/bust-storefront";

/**
 * Cache-tag invalidator for the catalog.
 *
 * Pages tag their cached reads (e.g. `'use cache' + cacheTag(CACHE_TAGS.productsList)`).
 * Writes emit events; this subscriber clears the matching tags without the
 * workflow knowing about caching. Tag strings come from the single
 * `@/lib/cache/tags` vocabulary so producer + consumer can't drift.
 * `bustCacheTag` expires the tag immediately (see that helper for the Next-16
 * profile-expire gotcha that `(tag, "default")` would hit).
 */

export function registerCatalogCacheSubscriber() {
  bus.on("product.created", ({ payload }) => {
    bust(CACHE_TAGS.productsList);
    bust(cacheTag.product(payload.productId));
    bust(cacheTag.productSlug(payload.slug));
  });

  bus.on("product.updated", ({ payload }) => {
    bust(CACHE_TAGS.productsList);
    bust(cacheTag.product(payload.productId));
    bust(cacheTag.productSlug(payload.slug));
  });

  bus.on("product.published", ({ payload }) => {
    bust(CACHE_TAGS.productsList);
    bust(cacheTag.product(payload.productId));
  });

  bus.on("product.unpublished", ({ payload }) => {
    bust(CACHE_TAGS.productsList);
    bust(cacheTag.product(payload.productId));
  });

  bus.on("product.deleted", ({ payload }) => {
    bust(CACHE_TAGS.productsList);
    bust(cacheTag.product(payload.productId));
  });

  // Category reads declare only the broad tag (no per-id reader), so the broad
  // bust is the whole invalidation.
  bus.on("category.created", () => bust(CACHE_TAGS.categories));
  bus.on("category.updated", () => bust(CACHE_TAGS.categories));
  bus.on("category.deleted", () => bust(CACHE_TAGS.categories));

  bus.on("brand.created", () => bust(CACHE_TAGS.brands));
  bus.on("brand.updated", () => bust(CACHE_TAGS.brands));
  bus.on("brand.deleted", () => bust(CACHE_TAGS.brands));

  // Reviews feed the DENORMALISED products.rating / reviews_count shown on the
  // (cached) PDP and its AggregateRating JSON-LD. A review write recomputes that
  // aggregate but goes through its OWN events (not product.updated), so bust the
  // product tag here or the cached PDP would show a stale rating until cacheLife.
  bus.on("catalog.review.created", ({ payload }) => bust(cacheTag.product(payload.productId)));
  bus.on("catalog.review.status_changed", ({ payload }) => bust(cacheTag.product(payload.productId)));
  bus.on("catalog.review.deleted", ({ payload }) => bust(cacheTag.product(payload.productId)));
  bus.on("catalog.review.created_manual", ({ payload }) => bust(cacheTag.product(payload.productId)));
  // Bulk fake-review cleanup spans many products without carrying their ids; bust
  // the broad list tag (the per-PDP rating self-heals within cacheLife — rare op).
  bus.on("catalog.review.bulk_deleted", () => bust(CACHE_TAGS.productsList));

  // Bulk data paths — the product import and the demo seed / clean / purge
  // write through bulk service calls (no per-row product/brand/category events),
  // so their terminal events expire every catalog + chrome tag at once. When the
  // emitter is a DETACHED runner the Next tag bust is best-effort (its request
  // already flushed — see bust-storefront.ts); the job pollers re-bust from a
  // live request the first time they see the job finished.
  bus.on("import.products_completed", () => bustStorefrontCache());
  bus.on("demo.imported", () => bustStorefrontCache());
  bus.on("demo.cleared", () => bustStorefrontCache());
  bus.on("demo.purged", () => bustStorefrontCache());
}
