/**
 * SINGLE SOURCE OF TRUTH for the three "Pages vitrine" (showcase collection)
 * slugs + their display labels. Isomorphic (no `server-only`, no DB) so every
 * consumer can derive from it instead of re-typing the list:
 *   - `collection-page-config.ts` (server) re-exports these + adds the
 *     strategy/config layer;
 *   - `slug-conflict.ts` spreads COLLECTION_SLUGS into RESERVED_ROUTES so an
 *     admin entity can never collide with a vitrine slug;
 *   - `link-target.ts` derives SYSTEM_PAGES (the nav/link picker) from it;
 *   - the admin showcase page derives its tab labels from COLLECTION_PAGE_LABELS.
 * Add a 4th collection here and all surfaces stay in sync automatically.
 */

export type CollectionSlug = "nouveautes" | "top-ventes" | "promotions" | "precommandes";

export const COLLECTION_SLUGS: readonly CollectionSlug[] = [
  "nouveautes",
  "top-ventes",
  "promotions",
  "precommandes",
];

export const COLLECTION_PAGE_LABELS: Record<CollectionSlug, string> = {
  nouveautes: "Nouveautés",
  "top-ventes": "Top ventes",
  promotions: "Promotions",
  precommandes: "Précommandes",
};

export function isCollectionSlug(s: string): s is CollectionSlug {
  return (COLLECTION_SLUGS as readonly string[]).includes(s);
}
