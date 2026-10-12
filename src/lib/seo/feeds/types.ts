/**
 * Shared, PURE types + tiny helpers for the product feeds. The two builders
 * (google-merchant.ts, acp-feed.ts) consume the SAME `FeedProduct[]` + `FeedMeta`
 * so the route maps the catalogue ONCE. No DB / no server-only here — fully
 * unit-testable.
 */

import { formatMoneyMachine } from "@/lib/price";

/** Internal availability vocabulary; each builder maps it to its own spelling. */
export type FeedAvailability = "in_stock" | "out_of_stock" | "backorder";

/** One feed row (already resolved to absolute URLs + plain text + millimes). */
export type FeedProduct = {
  /** Stable unique id per variant (ACP item_id / Google g:id). */
  id: string;
  /** Parent product id shared across variants (Google item_group_id / ACP group_id). */
  groupId?: string | null;
  title: string;
  /** PLAIN TEXT (HTML already stripped — ACP forbids HTML). */
  description: string;
  /** Absolute HTTPS product-page URL. */
  url: string;
  /** Absolute HTTPS primary image. */
  imageUrl: string;
  additionalImageUrls?: string[];
  /** Price in integer millimes (1/1000 of the major unit). */
  priceMinor: number;
  /** Sale price in millimes; included only when present AND <= priceMinor. */
  salePriceMinor?: number | null;
  availability: FeedAvailability;
  condition: "new" | "used" | "refurbished";
  brand?: string | null;
  gtin?: string | null;
  mpn?: string | null;
  /** Category breadcrumb "A > B > C". */
  categoryPath?: string | null;
  /** Variant axis map, e.g. { color: "navy", size: "M" }. */
  variant?: Record<string, string> | null;
  /** Google `g:sale_price_effective_date` window — the ISO-8601 start/end of the
   *  active fixed-window promo that governs `salePriceMinor`. Set ONLY when such a
   *  scheduled promo exists; a merchandiser compare-at (no schedule) leaves it null,
   *  so an indefinite markdown never advertises a bogus end date. */
  salePriceEffective?: { start: string; end: string } | null;
  reviewCount?: number | null;
  starRating?: number | null;
};

/** Feed-level metadata (store identity + formatting) shared by both builders. */
export type FeedMeta = {
  feedTitle: string;
  feedLink: string;
  feedDescription: string;
  sellerName: string;
  sellerUrl: string;
  /** ISO 4217 currency code (e.g. "TND"). */
  currency: string;
  /** Display decimals for the major unit (millimes → major is always /1000). */
  priceDecimals: number;
  storeCountry: string;
  targetCountries: string[];
  returnPolicyUrl: string;
  privacyUrl: string;
  tosUrl: string;
  /** Build timestamp for RSS `<lastBuildDate>` — RFC-822 (Date.toUTCString()).
   *  Injected so builders stay pure. */
  builtAt: string;
};

/**
 * Millimes → "169.500" for a feed (money is /1000). The feed price MUST match
 * the value in the PDP's Product JSON-LD Offer, which is emitted at full millime
 * precision — so we FLOOR at 3 decimals (millime scale) rather than the store's
 * *display* decimals. Display decimals default to 0, which would round 169.500
 * to "170" and trip Google Merchant's "mismatched value (price)" disapproval
 * against the landing page's structured data. A larger display setting (4) is
 * still honoured; the feed just never rounds BELOW the true stored precision.
 */
function formatFeedAmount(minor: number, decimals: number): string {
  // Shared SSOT with the storefront JSON-LD Offer so a feed price/shipping can
  // never disagree with the landing page (Merchant cross-checks them).
  return formatMoneyMachine(minor, decimals);
}

/** "169.000 TND" — number + ISO 4217 code (Google g:price + ACP price format). */
export function formatFeedPrice(minor: number, currency: string, decimals: number): string {
  return `${formatFeedAmount(minor, decimals)} ${currency}`;
}

/** Minimal XML escaper for attribute/text content (descriptions use CDATA instead). */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Wrap text in CDATA, neutralising any embedded "]]>" so the block can't break. */
export function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}
