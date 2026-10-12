/**
 * PURE (no DB / no server-only) canonical-URL resolver for the Markdown twins.
 *
 * A twin must declare the SAME canonical as its HTML page — both in the
 * frontmatter `url` and in the `Link: <…>; rel="canonical"` response header — or
 * it splits the signal the HTML page consolidates. The HTML pages honour the
 * entity's admin `canonical_url` override (SEO tab) and otherwise the FLAT
 * storefront path (`/${slug}`, also for a sub-category reached at
 * `/${parent}/${sub}`).
 *
 * The override is a free-form admin string, so only a usable value wins:
 *   • an absolute http(s) URL → as-is;
 *   • a root-relative path (`/x`, not protocol-relative `//x`) → origin-prefixed.
 * Anything else — or a value carrying whitespace, a non-printable / non-ASCII
 * byte or `<` `>` `"` (which would break or inject into the Link header, and a
 * non-ByteString value makes the Headers constructor throw) — falls back to the
 * flat path.
 */
const HEADER_SAFE_URL = /^[\x21-\x7E]+$/;

export function resolveTwinCanonical(
  override: string | null | undefined,
  origin: string,
  path: string,
): string {
  const raw = (override ?? "").trim();
  if (raw && HEADER_SAFE_URL.test(raw) && !/[<>"]/.test(raw)) {
    if (/^https?:\/\/[^/]/i.test(raw)) return raw;
    if (raw.startsWith("/") && !raw.startsWith("//")) return `${origin}${raw}`;
  }
  return `${origin}${path}`;
}
