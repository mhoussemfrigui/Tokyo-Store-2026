/**
 * Favoris DEMAND filter model — PURE, client-safe (no DB, no "server-only"), shared by the
 * favorites browser (client), the search action (server) and the filtered-export route
 * (server). The SQL that applies it lives in ./favorites-filter.ts.
 *
 * A "favorited product" is one product aggregated across EVERY wishlist that saved it
 * (live, non-deleted products only). The board is a merchandising demand signal: which
 * products customers want, how many want them, and — the actionable part — which are
 * OUT OF STOCK (restock priority). Amounts are millimes; recency windows count wishlist
 * saves (wishlist_items.created_at).
 */

export type FavStock = "any" | "in" | "out";
export type FavPublished = "any" | "yes" | "no";

/** One aggregated favorited-product row (server list + client table + export). */
export type FavoritedProductRow = {
  productId: string;
  name: string | null;
  slug: string | null;
  /** Total times this product has been favorited (all wishlists). */
  count: number;
  /** Favorites added in the last 30 days (momentum). */
  recent30: number;
  inStock: boolean;
  stockQty: number | null;
  priceCents: number;
  isPublished: boolean;
  categoryId: string | null;
  categoryName: string | null;
  categorySlug: string | null;
  lastAddedAt: string | null; // ISO
};

/** Stat-card counts over the filtered favorited-product set (each card doubles as a filter). */
export type FavoritesStats = {
  totalProducts: number; // distinct favorited products in the filtered set
  totalSaves: number; // sum of favorite instances
  inStock: number;
  outOfStock: number; // products favorited but out of stock — the restock signal
  recentSaves7: number;
  recentSaves30: number;
};

export type FavoritesFilter = {
  /** Product-name fragment. */
  search: string;
  stock: FavStock;
  /** Primary-category id ("" = any). */
  categoryId: string;
  published: FavPublished;
};

export const EMPTY_FAVORITES_FILTER: FavoritesFilter = {
  search: "",
  stock: "any",
  categoryId: "",
  published: "any",
};

export const FAV_STOCK_OPTIONS: ReadonlyArray<{ value: FavStock; label: string }> = [
  { value: "any", label: "Tous" },
  { value: "in", label: "En stock" },
  { value: "out", label: "En rupture" },
];

export const FAV_PUBLISHED_OPTIONS: ReadonlyArray<{ value: FavPublished; label: string }> = [
  { value: "any", label: "Tous" },
  { value: "yes", label: "Publiés" },
  { value: "no", label: "Dépubliés" },
];

/** True when the filter constrains nothing (used to short-circuit / label « tous »). */
export function isEmptyFavoritesFilter(f: FavoritesFilter): boolean {
  return (Object.keys(EMPTY_FAVORITES_FILTER) as Array<keyof FavoritesFilter>).every(
    (k) => f[k] === EMPTY_FAVORITES_FILTER[k],
  );
}

/** Non-default fields → a flat query object (for the export URL + audit). */
export function favoritesFilterToParams(f: FavoritesFilter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(EMPTY_FAVORITES_FILTER) as Array<keyof FavoritesFilter>) {
    if (f[k] !== EMPTY_FAVORITES_FILTER[k] && f[k] !== "") out[k] = String(f[k]);
  }
  return out;
}

const STOCK = new Set<string>(["any", "in", "out"]);
const PUB = new Set<string>(["any", "yes", "no"]);

/** Parse a query string (export route) back into a validated FavoritesFilter. Unknown /
 *  malformed values fall back to the empty default — never throws. */
export function favoritesFilterFromParams(get: (k: string) => string | null): FavoritesFilter {
  const stockRaw = get("stock") ?? "";
  const pubRaw = get("published") ?? "";
  return {
    search: (get("search") ?? "").slice(0, 120),
    stock: STOCK.has(stockRaw) ? (stockRaw as FavStock) : "any",
    categoryId: (get("categoryId") ?? "").slice(0, 64),
    published: PUB.has(pubRaw) ? (pubRaw as FavPublished) : "any",
  };
}
