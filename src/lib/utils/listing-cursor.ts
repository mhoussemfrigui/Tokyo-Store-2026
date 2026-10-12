import { isUuid } from "./uuid";

/**
 * Validate a storefront listing `?cursor=` (the blog / aide keyset cursor
 * `"<published_at ISO>__<uuid>"` that `listPosts` / `listArticles` emit as
 * `nextCursor`). Returns the cursor when it has exactly that shape, else
 * undefined → the caller renders page 1.
 *
 * The services already ignore a malformed cursor, but the blog listing loader is
 * `'use cache'` keyed on its arguments — so junk is dropped HERE, before it can
 * mint a cache entry per arbitrary query string. Pure (no DB), unit-tested.
 */
export function parseListingCursor(raw: string | string[] | undefined): string | undefined {
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!v || v.length > 80) return undefined;
  const sep = v.lastIndexOf("__");
  if (sep < 0) return undefined;
  const iso = v.slice(0, sep);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(iso)) return undefined;
  if (Number.isNaN(new Date(iso).getTime())) return undefined;
  return isUuid(v.slice(sep + 2)) ? v : undefined;
}
