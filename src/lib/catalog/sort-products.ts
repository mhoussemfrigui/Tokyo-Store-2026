import type { SortValue } from "./sort-options";

/**
 * The storefront listing sort (category / brand / collection / /recherche — all
 * rendered by `[slug]/category-client.tsx`), keyed by the STABLE `SortValue`s of
 * `SORT_OPTIONS`. PURE (no React, no server-only) so every option is unit-tested
 * (sort-options.test.ts) — « Nouveautés » used to fall through to the natural
 * order, a silent no-op identical to « En vedette ».
 *
 * Returns a NEW array (the input is never mutated). `Array.prototype.sort` is
 * stable, so ties keep the incoming (curated / relevance) order.
 */
type SortableProduct = {
  /** Major-unit display price (what the card shows). */
  price: number;
  name: string;
  /** ISO publication instant; absent on unstamped / older cached DTOs. */
  publishedAt?: string | null;
};

/** ms epoch of an ISO string, or null when absent / unparseable. */
function publishedMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Newest first — mirrors the listing index `published_at DESC NULLS LAST`: a
 * product without a (valid) publication date sorts AFTER every dated one, and
 * two undated products keep their relative order.
 */
export function compareNewest(a: SortableProduct, b: SortableProduct): number {
  const pa = publishedMs(a.publishedAt);
  const pb = publishedMs(b.publishedAt);
  if (pa === pb) return 0;
  if (pa === null) return 1;
  if (pb === null) return -1;
  return pb - pa;
}

export function sortProducts<T extends SortableProduct>(items: readonly T[], sort: SortValue): T[] {
  const res = [...items];
  switch (sort) {
    case "newest":
      return res.sort(compareNewest);
    case "price_asc":
      return res.sort((a, b) => a.price - b.price);
    case "price_desc":
      return res.sort((a, b) => b.price - a.price);
    case "name":
      return res.sort((a, b) => a.name.localeCompare(b.name, "fr"));
    case "featured":
      // Curated / natural order (relevance on /recherche) — left as received.
      return res;
    default: {
      // Exhaustiveness: a new SORT_OPTIONS value must get a case here.
      const unhandled: never = sort;
      void unhandled;
      return res;
    }
  }
}
