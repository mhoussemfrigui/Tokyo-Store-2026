/**
 * PURE search types — no "server-only", no DB import, so the config resolver
 * (parse-config.ts) and the pure test can share the `SearchKind` union without
 * pulling in the db-backed queries/service modules (which eagerly build the PG
 * pool at import and throw outside a real server env).
 *
 * queries.ts and service.ts re-export these so existing importers are unchanged.
 */

export type SearchKind =
  | "product"
  | "category"
  | "brand"
  | "blog_post"
  | "page";

/** Alias kept for the low-level reader layer (historically named *Kind). */
export type SearchHitKind = SearchKind;

export type SearchHit = {
  kind: SearchHitKind;
  id: string;
  slug: string;
  title: string;
  /** Short description / summary — may be null. */
  snippet: string | null;
  /** Soft link to a media row, when available. Resolved by the API layer. */
  image_media_id: string | null;
  /** Combined fts + trigram score; higher = better. */
  score: number;
};

export type ProductSearchHit = SearchHit & {
  kind: "product";
  /**
   * Effective unit price (millimes). Raw from the products table here; the
   * search SERVICE then applies the live promotion engine in place so it equals
   * the listing-card / PDP / cart price (see `enrichProductSearchHits`).
   */
  price_cents: number;
  /** Struck-through reference price (millimes) when discounted; else null. */
  old_price_cents: number | null;
  /** Live sell signal (`products.in_stock`) so the autocomplete dropdown can show
   *  an accurate availability dot without a second query. */
  in_stock: boolean;
};
