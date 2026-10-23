/**
 * PURE Google Merchant feed builder — RSS 2.0 + the `g:` namespace
 * (http://base.google.com/ns/1.0), one `<item>` per FeedProduct. Matches the
 * structure Google Merchant Center ingests (and the supplied sample feed),
 * emitting the standard `g:` fields only. No DB / no I/O → testable.
 */
import {
  cdata,
  formatFeedPrice,
  xmlEscape,
  type FeedAvailability,
  type FeedMeta,
  type FeedProduct,
} from "./types";

/** Google g:availability vocabulary (matches the example's in_stock/out_of_stock). */
const GOOGLE_AVAILABILITY: Record<FeedAvailability, string> = {
  in_stock: "in_stock",
  out_of_stock: "out_of_stock",
  backorder: "backorder",
  preorder: "preorder",
};

function tag(name: string, value: string): string {
  return `  <${name}>${value}</${name}>`;
}

/**
 * Standard Google variant attributes derivable from a variant-axis dict
 * ({axisLabel: valueLabel}). The axis labels are the admin's attribute names, so
 * match the common FR/EN spellings and map each to its `g:` field. Mirrors (and
 * extends past color/size) the ACP feed's axis extraction. Only RECOGNISED axes
 * are emitted — an unknown axis is left to `g:item_group_id` alone, never guessed
 * into a wrong attribute. First matching axis wins per attribute.
 */
const GOOGLE_VARIANT_AXES: ReadonlyArray<{ attr: string; re: RegExp }> = [
  { attr: "color", re: /(couleur|coloris|color)/i },
  { attr: "size", re: /(taille|pointure|size)/i },
  { attr: "material", re: /(mati[eè]re|mat[ée]riau|material)/i },
  { attr: "capacity", re: /(capacit[eé]|capacity)/i },
];

function googleVariantAttributes(
  variant: Record<string, string> | null | undefined,
): Array<{ attr: string; value: string }> {
  if (!variant) return [];
  const out: Array<{ attr: string; value: string }> = [];
  for (const { attr, re } of GOOGLE_VARIANT_AXES) {
    for (const [axis, value] of Object.entries(variant)) {
      if (re.test(axis) && value) {
        out.push({ attr, value });
        break;
      }
    }
  }
  return out;
}

function item(p: FeedProduct, meta: FeedMeta): string {
  const lines: string[] = [];
  lines.push(`<item>`);
  lines.push(tag("g:id", xmlEscape(p.id)));
  lines.push(tag("g:title", xmlEscape(p.title.slice(0, 150))));
  lines.push(`  <g:description>${cdata(p.description.slice(0, 5000))}</g:description>`);
  lines.push(tag("g:link", xmlEscape(p.url)));
  lines.push(tag("g:image_link", xmlEscape(p.imageUrl)));
  for (const img of (p.additionalImageUrls ?? []).slice(0, 10)) {
    lines.push(tag("g:additional_image_link", xmlEscape(img)));
  }
  lines.push(tag("g:price", xmlEscape(formatFeedPrice(p.priceMinor, meta.currency, meta.priceDecimals))));
  if (p.salePriceMinor != null && p.salePriceMinor <= p.priceMinor) {
    lines.push(tag("g:sale_price", xmlEscape(formatFeedPrice(p.salePriceMinor, meta.currency, meta.priceDecimals))));
    // Only when a scheduled (fixed-window) promo governs the sale price — Google
    // then shows the sale only inside the window and never past a lapsed sale.
    if (p.salePriceEffective) {
      lines.push(
        tag(
          "g:sale_price_effective_date",
          xmlEscape(`${p.salePriceEffective.start}/${p.salePriceEffective.end}`),
        ),
      );
    }
  }
  lines.push(tag("g:availability", GOOGLE_AVAILABILITY[p.availability]));
  // Google requires g:availability_date alongside a preorder availability (when it
  // ships). ISO-8601 instant, straight from the product's release date.
  if (p.availability === "preorder" && p.availabilityDate) {
    lines.push(tag("g:availability_date", xmlEscape(p.availabilityDate)));
  }
  lines.push(tag("g:condition", p.condition));
  if (p.brand) lines.push(tag("g:brand", xmlEscape(p.brand.slice(0, 70))));
  if (p.gtin) lines.push(tag("g:gtin", xmlEscape(p.gtin)));
  if (p.mpn) lines.push(tag("g:mpn", xmlEscape(p.mpn)));
  // Google requires identifier_exists=no when none of brand/gtin/mpn is present.
  if (!p.brand && !p.gtin && !p.mpn) lines.push(tag("g:identifier_exists", "no"));
  if (p.categoryPath) lines.push(tag("g:product_type", xmlEscape(p.categoryPath)));
  if (p.groupId) lines.push(tag("g:item_group_id", xmlEscape(p.groupId)));
  // Standard variant attributes (g:color / g:size / g:material / g:capacity) from
  // the resolved variant axes, so siblings under one item_group_id are told apart.
  for (const { attr, value } of googleVariantAttributes(p.variant)) {
    lines.push(tag(`g:${attr}`, xmlEscape(value.slice(0, 100))));
  }
  lines.push(`</item>`);
  return lines.join("\n");
}

/** Build the full Google Merchant RSS feed XML string. */
export function buildGoogleMerchantFeed(products: readonly FeedProduct[], meta: FeedMeta): string {
  const header =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n` +
    `<channel>\n` +
    `<title>${xmlEscape(meta.feedTitle)}</title>\n` +
    `<link>${xmlEscape(meta.feedLink)}</link>\n` +
    `<description>${xmlEscape(meta.feedDescription)}</description>\n` +
    `<lastBuildDate>${xmlEscape(meta.builtAt)}</lastBuildDate>`;
  const body = products.map((p) => item(p, meta)).join("\n");
  return `${header}\n${body}\n</channel>\n</rss>\n`;
}
