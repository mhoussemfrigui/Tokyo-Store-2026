import "server-only";

import { mediaQueries, resolveMediaThumbUrl } from "@/modules/media";

/**
 * Batch-resolve a set of chip-icon media ids to their storefront image URLs
 * (anti-N+1). The storefront listing "thumbs" strip lets each category / brand /
 * collection set a CUSTOM médiathèque image (`icon_media_id`) that wins over the
 * curated lucide key. Every chip image goes through the SAME médiathèque
 * pipeline as hero / logo / OG images — `mediaQueries.findMediaByIds` +
 * `resolveMediaUrl` (the CDN/same-origin resolver) — never a hardcoded URL.
 *
 * Pass every chip's `icon_media_id` (nulls/dupes are ignored); the returned map
 * holds `mediaId → url` only for ids that resolved. One DB round-trip total.
 */
export async function resolveChipIconUrls(
  mediaIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const ids = Array.from(
    new Set(mediaIds.filter((x): x is string => Boolean(x))),
  );
  if (ids.length === 0) return new Map<string, string>();

  const media = await mediaQueries.findMediaByIds(ids).catch(() => new Map());
  const out = new Map<string, string>();
  for (const id of ids) {
    // webp-first thumbnail URL: the chip is drawn in a bare <img> (no <picture>),
    // so it can't fall back from AVIF — match the codebase's raw-<img> contract.
    const url = resolveMediaThumbUrl(media.get(id));
    if (url) out.set(id, url);
  }
  return out;
}
