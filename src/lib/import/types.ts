import { dinarsToMinor } from "@/lib/price";

/**
 * Product-import draft shapes shared by the two file parsers
 * (parse-google-feed.ts, parse-csv.ts) and the background runner
 * (src/workflows/import/run-product-import.ts).
 *
 * Pure + isomorphic on purpose (no `server-only`, no DB imports) so the
 * admin UI can import the types for display without dragging server code
 * into the client bundle. Note: `slugify` is NOT redefined here — the repo
 * already exports one canonical implementation from `@/lib/slug`; both
 * parsers reuse it so import slugs can never disagree with admin-created
 * ones.
 */

/** One product as drafted from an uploaded file — not yet a DB row. */
export type ImportedProduct = {
  /** Feed `g:id` (XML) — null for CSV rows. Used only for error labels. */
  sourceId: string | null;
  title: string;
  slug: string;
  /** Original product URL (`g:link`) — the slug is derived from it. */
  link: string | null;
  description: string | null;
  /**
   * CSV-only `short_desc` column. XML feeds carry a single description, so
   * the runner falls back to `description` when this is null.
   */
  shortDesc: string | null;
  /** Main image first, then additional images. Deduplicated, capped by the runner at 8. */
  imageUrls: string[];
  /** Integer minor units (millimes — 1 TND = 1000). Always > 0. */
  priceMinor: number;
  oldPriceMinor: number | null;
  availability: "in_stock" | "out_of_stock" | "backorder" | null;
  brandName: string | null;
  /** Kept as TEXT end-to-end — leading zeros are significant. */
  gtin: string | null;
  mpn: string | null;
  /** Breadcrumb segments ("Smartphones / Apple"), junk tail already dropped. */
  categoryPath: string[];
  metaTitle: string | null;
  metaDescription: string | null;
};

/**
 * Common return shape of BOTH parsers. Per-row soft failures (missing
 * name, unparseable price…) land in `rowErrors` instead of aborting the
 * whole file — the runner seeds the job's `errors` list with them.
 */
export type ParsedImport = {
  products: ImportedProduct[];
  rowErrors: string[];
};

/* ────────────────────────────────────────────────────────── entities */

/**
 * Decode the residual HTML entities real-world feeds leave behind.
 *
 * The source feed double-encodes text (`Festina Boyfriend &amp;#039;Chic&amp;#039;`), so
 * after fast-xml-parser's own entity pass you still hold `&#039;`. This
 * helper runs the extra decode passes: numeric decimal (`&#39;`), numeric
 * hex (`&#x27;`) and the five named XML entities. Loops (capped at 3) until
 * no entity pattern remains, so single- and double-encoded inputs both come
 * out clean.
 */
export function decodeEntities(input: string): string {
  let out = input;
  for (let pass = 0; pass < 3 && ENTITY_PATTERN.test(out); pass += 1) {
    out = decodeEntitiesOnce(out);
  }
  return out;
}

const ENTITY_PATTERN = /&(?:#\d+|#x[0-9a-fA-F]+|amp|lt|gt|quot|apos);/;

function decodeEntitiesOnce(input: string): string {
  return (
    input
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => fromCodePointSafe(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec: string) => fromCodePointSafe(parseInt(dec, 10)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      // `&amp;` LAST so `&amp;#039;` collapses to `&#039;` and the next
      // pass's numeric decode finishes the job.
      .replace(/&amp;/g, "&")
  );
}

function fromCodePointSafe(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return ""; // out-of-range reference — drop it rather than crash the row
  }
}

/* ────────────────────────────────────────────────────────── price */

/**
 * "169.00 TND" / "1 249,500" / "249" → integer minor units, or null when
 * nothing parseable remains (the caller records a per-row error — we never
 * invent a 0 price). Strips everything but digits/dot/comma; when both
 * separators appear the right-most one is the decimal mark (the other is a
 * thousands separator); a lone comma is a decimal mark.
 */
export function parsePriceToMinor(raw: string): number | null {
  let s = raw.replace(/[^0-9.,]/g, "");
  if (!s) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot !== -1 && lastComma !== -1) {
    s =
      lastComma > lastDot
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else {
    s = s.replace(/,/g, ".");
  }
  const value = parseFloat(s);
  if (!Number.isFinite(value) || value <= 0) return null;
  return dinarsToMinor(value);
}
