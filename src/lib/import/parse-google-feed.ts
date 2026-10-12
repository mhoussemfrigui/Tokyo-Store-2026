import { XMLParser, XMLValidator } from "fast-xml-parser";

import { slugify } from "@/lib/slug";
import {
  decodeEntities,
  parsePriceToMinor,
  type ImportedProduct,
  type ParsedImport,
} from "./types";

/**
 * Google-Merchant RSS feed parser (`<rss><channel><item>` with `g:`/`cmp:`
 * namespaced tags). Tolerant of the real export's quirks:
 *
 *   - double-encoded entities in titles/descriptions (second decode pass)
 *   - `g:additional_image_link` repeated 0..7 times (string OR array)
 *   - `g:gtin` with leading zeros (parseTagValue: false → always strings)
 *   - `g:product_type` breadcrumbs that end with the product's own name
 *     (junk tail dropped via normalized prefix-match against the title)
 *
 * File-level problems (not XML, no `<channel>`) THROW — the caller turns
 * that into a job failure. Item-level problems (no title, bad price) are
 * collected into `rowErrors` and the item is skipped, so one bad row never
 * sinks the other 900.
 */
export function parseGoogleFeed(xml: string): ParsedImport {
  // Strip a leading UTF-8 BOM (exported feeds often carry one) so the XML
  // validator doesn't choke on a stray char before the prolog.
  const text = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const valid = XMLValidator.validate(text);
  if (valid !== true) {
    throw new Error(`XML invalide : ${valid.err?.msg ?? "structure illisible"}`);
  }

  const parser = new XMLParser({
    ignoreAttributes: true,
    // Keep every value a string — parsing "00123" to a number would destroy
    // GTIN leading zeros.
    parseTagValue: false,
    trimValues: true,
  });
  const doc = parser.parse(text) as Record<string, unknown>;

  const rss = asRecord(doc?.rss);
  const channel = asRecord(firstOf(rss?.channel));
  if (!channel) {
    throw new Error("Flux RSS invalide : structure <rss><channel><item> attendue.");
  }

  const items = toArray(channel.item).map(asRecord).filter(Boolean) as Record<string, unknown>[];

  const products: ImportedProduct[] = [];
  const rowErrors: string[] = [];

  items.forEach((item, index) => {
    const sourceId = asText(item["g:id"]);
    const label = sourceId ? `Article ${sourceId}` : `Article #${index + 1}`;
    try {
      const titleRaw = asText(item["g:title"]);
      if (!titleRaw) throw new Error("titre manquant");
      const title = decodeEntities(titleRaw);

      const priceRaw = asText(item["g:price"]);
      const priceMinor = priceRaw ? parsePriceToMinor(priceRaw) : null;
      if (priceMinor === null) {
        throw new Error(`prix manquant ou invalide (« ${priceRaw ?? ""} »)`);
      }

      const link = asText(item["g:link"]);
      const descriptionRaw = asText(item["g:description"]);
      const metaDescriptionRaw = asText(item["cmp:meta_description"]);
      const metaTitleRaw = asText(item["cmp:meta_title"]);

      const imageUrls = dedupe(
        [asText(item["g:image_link"]), ...toArray(item["g:additional_image_link"]).map(asText)].filter(
          (u): u is string => Boolean(u),
        ),
      );

      products.push({
        sourceId,
        title,
        slug: slugFromLink(link, title),
        link,
        description: descriptionRaw ? decodeEntities(descriptionRaw) : null,
        shortDesc: null, // XML feeds carry a single description
        imageUrls,
        priceMinor,
        oldPriceMinor: null, // the feed has no compare-at price tag
        availability: parseAvailability(asText(item["g:availability"])),
        // The tech feed's `g:brand` is the REAL brand (Apple, Samsung, JBL…). The
        // old watch-era title/product_type override (resolveBrandName) was removed —
        // it mis-branded tech products onto watch names (Casio/GC/…).
        brandName: nullableDecoded(asText(item["g:brand"])),
        gtin: asText(item["g:gtin"]),
        mpn: asText(item["g:mpn"]),
        categoryPath: parseCategoryPath(asText(item["g:product_type"]), title),
        metaTitle: nullableDecoded(metaTitleRaw),
        metaDescription: nullableDecoded(metaDescriptionRaw),
      });
    } catch (err) {
      rowErrors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return { products, rowErrors };
}

/* ────────────────────────────────────────────────────────── slug */

/**
 * Derive the slug from the product URL's basename so imported products keep
 * the EXACT slugs of the live store being migrated from:
 *
 *   …/43-casio-g-shock-ga-2100-montre-homme-tunisie.html
 *     → casio-g-shock-ga-2100-montre-homme-tunisie
 *
 * (strip `.html`, strip the PrestaShop-style numeric `NN-` prefix). When the
 * leftover isn't a clean slug, fall back to slugifying the title.
 */
function slugFromLink(link: string | null, title: string): string {
  if (link) {
    try {
      const segments = new URL(link).pathname.split("/").filter(Boolean);
      const basename = segments[segments.length - 1] ?? "";
      const candidate = basename
        .replace(/\.html?$/i, "")
        .replace(/^\d+-/, "")
        .toLowerCase();
      if (/^[a-z0-9-]+$/.test(candidate)) return candidate;
    } catch {
      // unparseable URL — fall through to the title
    }
  }
  return slugify(title);
}

/* ────────────────────────────────────────────────────────── category path */

/**
 * "Smartphones / Apple / iPhone 15" → segments, with the LAST
 * segment dropped when it is really the product's own name glued onto the
 * breadcrumb (compared via lowercase-alphanumeric prefix match against the
 * first 20 chars of the title). "(none)" / empty → [].
 */
function parseCategoryPath(raw: string | null, title: string): string[] {
  const decoded = raw ? decodeEntities(raw).trim() : "";
  if (!decoded || decoded.toLowerCase() === "(none)") return [];

  const segments = decoded
    .split(" / ")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return segments;

  const titleNorm = normAlnum(title).slice(0, 20);
  const tailNorm = normAlnum(segments[segments.length - 1]).slice(0, 20);
  if (titleNorm && tailNorm && (titleNorm.startsWith(tailNorm) || tailNorm.startsWith(titleNorm))) {
    segments.pop();
  }
  return segments;
}

/** Lowercase + strip diacritics + keep alphanumerics only ("GA-2100!" → "ga2100"). */
function normAlnum(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

/* ────────────────────────────────────────────────────────── small coercers */

function parseAvailability(raw: string | null): ImportedProduct["availability"] {
  if (!raw) return null;
  const v = raw.trim().toLowerCase().replace(/\s+/g, "_");
  if (v === "in_stock" || v === "out_of_stock" || v === "backorder") return v;
  return null;
}

function nullableDecoded(value: string | null): string | null {
  return value ? decodeEntities(value) : null;
}

/** Repeated XML tags parse to arrays, single ones to scalars — normalize. */
function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Tolerant text extraction: string, number, or `{ "#text": … }` node. */
function asText(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) {
    return asText((v as Record<string, unknown>)["#text"]);
  }
  return null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
