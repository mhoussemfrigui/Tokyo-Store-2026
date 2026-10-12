import "server-only";

import { revalidatePath } from "next/cache";

import { bus } from "../bus";

/**
 * Route invalidator for the promotion module.
 *
 * Promotions cross-cut the storefront: product cards, category pages, the
 * cart drawer, and the checkout summary all need to refresh whenever a
 * promotion changes. No promotion read is cross-request cached (live promos
 * are resolved per request — the cached PDP DTO is the BASE product, promos
 * are applied after it), so there is no cache tag to bust: revalidating the
 * root layout makes every server-rendered surface pick up the new state on the
 * next request.
 */

const bustAll = () => {
  revalidatePath("/", "layout");
};

export function registerPromotionCacheSubscriber() {
  bus.on("promotion.created", bustAll);
  bus.on("promotion.updated", bustAll);
  bus.on("promotion.deleted", bustAll);
  bus.on("promotion.activated", bustAll);
  bus.on("promotion.deactivated", bustAll);
}
