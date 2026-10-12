import "server-only";

import { mediaQueries } from "@/modules/media";
import { resolveMediaUrl } from "@/modules/media/url-resolver";

/** A resolved value-prop card — its optional custom icon image turned into a URL. */
export type ResolvedValueProp = { icon: string; iconUrl: string | null; title: string; body: string };

/**
 * Resolve the OPTIONAL custom médiathèque icon image on each editorial value-prop
 * card into a URL (`iconUrl`), batched in one query. A card with no custom image
 * keeps `iconUrl: null` and the storefront falls back to its lucide icon. Shared
 * by the category (`/[slug]`), sub-category (`/[slug]/[sub]`) and brand editorial
 * builders so none of them drops the operator's custom icons. Server-only (DB +
 * media resolution) — the client picker uses value-prop-icons.ts instead.
 */
export async function resolveValuePropIcons(
  valueProps:
    | Array<{ icon: string; iconMediaId?: string | null; title: string; body: string }>
    | null
    | undefined,
): Promise<ResolvedValueProp[] | null> {
  if (!valueProps || valueProps.length === 0) return null;
  const ids = valueProps.map((v) => v.iconMediaId).filter((x): x is string => !!x);
  const urlById = new Map<string, string>();
  if (ids.length > 0) {
    const media = await mediaQueries.findMediaByIds(ids).catch(() => new Map());
    for (const id of ids) {
      const url = resolveMediaUrl(media.get(id));
      if (url) urlById.set(id, url);
    }
  }
  return valueProps.map((v) => ({
    icon: v.icon,
    iconUrl: v.iconMediaId ? (urlById.get(v.iconMediaId) ?? null) : null,
    title: v.title,
    body: v.body,
  }));
}
