/**
 * Per-product schema.org `sameAs` — the official external URLs that represent
 * the SAME product (manufacturer page, official store, authoritative listing).
 *
 * Stored as free text (one URL per line, comma also accepted) on
 * `products.same_as`, mirroring how the global `seo.*` sameAs / knowsAbout lists
 * are stored. This is the SINGLE place that turns that raw text into a clean,
 * validated URL list — used by the storefront DTO mapper (for the Product
 * JSON-LD) so the schema can never emit a malformed / non-http / relative URL.
 *
 * Pure + dependency-free → unit-tested in db/tests/same-as.test.ts.
 */

/** Hard cap so a pasted blob can't bloat the JSON-LD graph. */
export const MAX_SAME_AS = 10;

/**
 * Parse the stored `same_as` text into a deduped list of valid absolute
 * http(s) URLs (order preserved). Rejects relative URLs, non-http(s) schemes
 * (mailto:, javascript:, data:, ftp:, …), and anything `new URL()` can't parse.
 * Returns `[]` for null/empty/all-invalid input — callers treat `[]` as "none".
 */
export function parseSameAs(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Split on newlines and commas; tolerate Windows CRLF and stray whitespace.
  for (const token of raw.split(/[\n,]+/)) {
    const candidate = token.trim();
    if (!candidate) continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue; // not a parseable absolute URL → drop
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const normalized = url.toString();
    // Dedupe case-sensitively on the normalized form (URLs are case-sensitive
    // past the host, so we don't lower-case the whole thing).
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= MAX_SAME_AS) break;
  }
  return out;
}

