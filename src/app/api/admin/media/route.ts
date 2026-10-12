import { NextResponse } from "next/server";

import { findMediaByIds } from "@/modules/media/queries";
import { mediaService } from "@/modules/media/service";
import { primeCdnBase, getCdnBaseSync } from "@/modules/media/cdn-base";
import { resolveMediaUrl, resolveMediaThumbUrl } from "@/modules/media/url-resolver";
import { requirePermission } from "@/lib/auth/session";
import { isUuid } from "@/lib/utils/uuid";
import { normalizePublicUrl } from "@/lib/utils/public-url";

/**
 * Admin-only media browser.
 *
 *   GET /api/admin/media?q=hero&cursor=<iso>&limit=24
 *
 * Used by <MediaPicker> to fetch a slice of the library without rendering
 * a separate route. Returns a stable shape that's safe to extend:
 *
 *   { items: MediaCard[], nextCursor: string | null }
 *
 * `requirePermission("media", "view")` falls through to 404 when the caller
 * lacks it, so the endpoint is invisible to anonymous traffic. No public surface.
 */

export async function GET(request: Request) {
  await requirePermission("media", "view");
  // Prime the effective CDN base before the sync `normalizePublicUrl` calls in
  // mapMedia so the picker shows the same CDN-based URLs the storefront serves.
  await primeCdnBase();
  const cdnBase = getCdnBaseSync();
  const url = new URL(request.url);
  const idsParam = url.searchParams.get("ids");

  // ids= mode: lookup mode for hydrating already-selected media in
  // <MediaPicker>. Caps at 50 IDs per call to avoid runaway lookups.
  // Bad UUIDs are silently dropped — mixed valid/invalid input is a normal
  // client-side reality (stale references, typos, malicious probes) and we
  // don't want a single bad ID to 500 the whole batch.
  if (idsParam) {
    const ids = idsParam
      .split(",")
      .map((s) => s.trim())
      .filter(isUuid)
      .slice(0, 50);
    if (ids.length === 0) return NextResponse.json({ items: [], nextCursor: null });
    const map = await findMediaByIds(ids);
    const items = Array.from(map.values()).map((m) => mapMedia(m, cdnBase));
    return NextResponse.json({ items, nextCursor: null });
  }

  const search = url.searchParams.get("q") ?? undefined;
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const limit = Number(url.searchParams.get("limit") ?? 24);

  const { items, nextCursor } = await mediaService.list({
    search,
    cursor,
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 24,
  });

  return NextResponse.json({
    items: items.map((m) => mapMedia(m, cdnBase)),
    nextCursor,
  });
}

function mapMedia(
  m: {
    id: string;
    url: string;
    url_override: string | null;
    webp_url: string | null;
    avif_url: string | null;
    original_url: string | null;
    filename: string;
    width: number | null;
    height: number | null;
    size_bytes: number;
    alt_text: string | null;
    mime_type: string;
    created_at: Date;
  },
  cdnBase: string,
) {
  return {
    id: m.id,
    // Canonical resolver chains (empty-string-safe firstNonEmpty; avif-first for
    // display, webp-first for the raw-<img> thumbnail) — the same ones the
    // storefront/picker use everywhere else. A bare `url_override ?? url` skips
    // only null, so an empty-string override would blank the URL.
    url: resolveMediaUrl(m) ?? "",
    thumbUrl: resolveMediaThumbUrl(m) ?? "",
    filename: m.filename,
    width: m.width,
    height: m.height,
    sizeBytes: m.size_bytes,
    altText: m.alt_text,
    mimeType: m.mime_type,
    // Which derived variants exist (the picker renders these as chips).
    hasWebp: Boolean(m.webp_url),
    hasAvif: Boolean(m.avif_url),
    hasOriginal: Boolean(m.original_url),
    urlOverride: m.url_override,
    // The variant URLs + upload date — read by the Médiathèque « Charger plus »
    // (its cards link each variant chip to the asset, like the server-rendered page).
    variants: {
      webp: normalizePublicUrl(m.webp_url, cdnBase),
      avif: normalizePublicUrl(m.avif_url, cdnBase),
      original: normalizePublicUrl(m.original_url, cdnBase),
    },
    createdAt: m.created_at.toISOString(),
  };
}
