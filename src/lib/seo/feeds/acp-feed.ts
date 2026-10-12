/**
 * PURE OpenAI Agentic Commerce Protocol (ACP) feed builder — the JSON shape
 * ChatGPT Shopping ingests: `{ "products": [ {product}, ... ] }`. Emits the 15
 * REQUIRED fields + applicable conditional fields, enforcing the strict rules:
 *   - booleans are lower-case STRINGS ("true"/"false");
 *   - price/sale_price embed the ISO-4217 currency in the value ("169.000 TND");
 *   - dates ISO-8601; URLs HTTPS; description plain text; sale_price <= price;
 *   - country codes ISO 3166-1 alpha-2; item_id stable + unique per variant.
 * No DB / no I/O → unit-testable. Returns a JSON string (valid JSON only).
 */
import {
  formatFeedPrice,
  type FeedAvailability,
  type FeedMeta,
  type FeedProduct,
} from "./types";

/** ACP availability vocabulary (in_stock | out_of_stock | backorder). */
function acpAvailability(a: FeedAvailability): string {
  return a;
}

const COLOR_KEY = /(couleur|color)/i;
const SIZE_KEY = /(taille|size|pointure)/i;

function pickVariantAxis(variant: Record<string, string> | null | undefined, re: RegExp): string | undefined {
  if (!variant) return undefined;
  for (const [k, v] of Object.entries(variant)) {
    if (re.test(k) && v) return v;
  }
  return undefined;
}

/** Build a single ACP product object (the conditional fields are added when present). */
export function buildAcpProduct(p: FeedProduct, meta: FeedMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {
    // booleans are lower-case STRINGS, never native bool
    is_eligible_search: "true",
    is_eligible_checkout: "false", // no agentic checkout integration (yet)
    item_id: p.id.slice(0, 100),
    title: p.title.slice(0, 150),
    description: p.description.slice(0, 5000),
    url: p.url,
    brand: (p.brand || meta.sellerName).slice(0, 70),
    image_url: p.imageUrl,
    price: formatFeedPrice(p.priceMinor, meta.currency, meta.priceDecimals),
    availability: acpAvailability(p.availability),
    seller_name: meta.sellerName.slice(0, 70),
    seller_url: meta.sellerUrl,
    return_policy: meta.returnPolicyUrl,
    target_countries: meta.targetCountries,
    store_country: meta.storeCountry,
    // Always provided (cheap; required were checkout ever enabled).
    seller_privacy_policy: meta.privacyUrl,
    seller_tos: meta.tosUrl,
  };

  if (p.salePriceMinor != null && p.salePriceMinor <= p.priceMinor) {
    out.sale_price = formatFeedPrice(p.salePriceMinor, meta.currency, meta.priceDecimals);
  }
  if (p.gtin) out.gtin = p.gtin;
  if (p.mpn) out.mpn = p.mpn;
  if (p.categoryPath) out.product_category = p.categoryPath;
  if (p.groupId) out.group_id = p.groupId;
  if (p.variant && Object.keys(p.variant).length > 0) {
    out.variant_dict = p.variant;
    const color = pickVariantAxis(p.variant, COLOR_KEY);
    const size = pickVariantAxis(p.variant, SIZE_KEY);
    if (color) out.color = color;
    if (size) out.size = size;
  }
  if (typeof p.reviewCount === "number" && p.reviewCount > 0) {
    out.review_count = p.reviewCount;
    if (typeof p.starRating === "number" && p.starRating > 0) out.star_rating = p.starRating;
  }
  return out;
}

/** Build the full ACP feed JSON string: `{ "products": [ ... ] }`. */
export function buildAcpFeed(products: readonly FeedProduct[], meta: FeedMeta): string {
  return JSON.stringify({ products: products.map((p) => buildAcpProduct(p, meta)) }, null, 2);
}
