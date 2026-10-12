import "server-only";

import { bus } from "../bus";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { bustCacheTag as bust } from "@/lib/cache/revalidate";

/**
 * Cache-tag invalidator for product attributes & category filters.
 *
 * Attribute definitions, attribute values, and the category→filterable-attribute
 * mapping all feed the storefront's filter facets and the product detail
 * specs panels. A change to any one of them can shift which products appear
 * under a category filter, so we bust the broad `categories`, `products`,
 * and `attributes` tags together (from the shared `@/lib/cache/tags` vocabulary).
 * `bustCacheTag` expires the tag immediately (see that helper for why the
 * Next-16 `(tag, "default")` form would only mark it stale).
 */

const bustAll = () => {
  bust(CACHE_TAGS.categories);
  bust(CACHE_TAGS.products);
  bust(CACHE_TAGS.attributes);
};

export function registerAttributeCacheSubscriber() {
  bus.on("attribute.created", bustAll);
  bus.on("attribute.updated", bustAll);
  bus.on("attribute.deleted", bustAll);
  bus.on("attribute_value.created", bustAll);
  bus.on("attribute_value.updated", bustAll);
  bus.on("attribute_value.deleted", bustAll);
  bus.on("category.filter_attributes.updated", bustAll);
}
