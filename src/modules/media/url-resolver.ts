import { normalizePublicUrl } from "@/lib/utils/public-url";

import { getCdnBaseSync } from "./cdn-base";
import type { MediaRow } from "./schema";

/**
 * Centralised media URL resolvers. Three flavours, all funnelling through
 * `normalizePublicUrl` (rewrites leftover absolute object-store URLs to the
 * same-origin `/cdn/<key>` form) and never throwing:
 *
 *  ── resolveMediaUrl  (DISPLAY) ────────────────────────────────────────
 *  AVIF-first. Feeds on-page `<Image>` rendering (product gallery, cards,
 *  search hits), which always goes through Next's optimizer
 *  (`formats: ["image/avif","image/webp"]`). Preferring the pre-generated
 *  `avif_url` means the SMALLEST modern format is the canonical source —
 *  the "main show image" is AVIF wherever a variant exists.
 *    chain: url_override → avif_url → webp_url → url → original_url
 *
 *  ── resolveMediaThumbUrl  (THUMBNAIL) ─────────────────────────────────
 *  WEBP-first (compat), deliberately NOT avif-first. Some admin grids
 *  render thumbnails in a *raw* `<img>` (Médiathèque, stock list) with
 *  no Next negotiation and no `<picture>` fallback — a raw AVIF `<img>`
 *  would break on browsers without AVIF support. WEBP is near-universal in
 *  raw `<img>`, and the MediaPicker's `<Image>` still up-negotiates the
 *  webp source to AVIF on-page, so callers lose nothing.
 *    chain: url_override → webp_url → url → original_url   (never avif)
 *
 *  ── resolveMediaSocialUrl  (OG / JSON-LD / external) ───────────────────
 *  AVIF-avoiding too. og:image scrapers (Facebook, LinkedIn) and email
 *  clients (Gmail/Outlook) don't reliably render AVIF, so social/meta
 *  contexts get a broadly-compatible variant instead.
 *    chain: url_override → webp_url → url → original_url   (never avif)
 *
 * The fallback chain matters for imported rows: PrestaShop/Shopify imports
 * populate `webp_url` / `url_override` but can leave `url` empty, so every
 * resolver walks the full chain — preventing "shows in admin but not the
 * storefront" from a single missing field.
 *
 * CDN base: each resolver reads the effective CDN base synchronously via
 * `getCdnBaseSync()` (DB `media_settings.cdn_base_url` PRIMARY → `MEDIA_CDN_URL`
 * env FALLBACK → "" default same-origin `/cdn` proxy). When set, every
 * resolved `/cdn/<key>` path is rewritten to `<base>/<key>`. The base is
 * memoised module-side and refreshed via `primeCdnBase()`; reads never block.
 *
 * Returns `null` only when NO url field is set.
 */

type MediaUrlFields = Pick<
  MediaRow,
  "url" | "url_override" | "webp_url" | "avif_url" | "original_url"
>;

/**
 * First field that is a non-empty (trimmed) string; `null` if none. Used
 * instead of a bare `??` chain so an EMPTY-STRING field (e.g. an import that
 * wrote `url=""` rather than null) doesn't short-circuit the fallback — `??`
 * only skips null/undefined, so `"" ?? next` would wrongly stop at `""`.
 */
function firstNonEmpty(...vals: (string | null | undefined)[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return null;
}

/**
 * The human alt text stored on a media row (the Médiathèque "alt" field),
 * trimmed, or `null` when none is set. Storefront callers fall back to a
 * SEMANTIC name (product / brand / category / post title) — never the
 * `filename`, which would leak ugly slugs (`abc-uuid-screenshot.jpg`) into
 * `alt` attributes and hurt accessibility + SEO. The admin Médiathèque grid is
 * the one place that intentionally falls back to the filename for its own
 * preview labelling.
 */
export function resolveMediaAlt(
  m: { alt_text?: string | null } | null | undefined,
): string | null {
  const t = m?.alt_text?.trim();
  return t ? t : null;
}

/** Display source — AVIF-first (smallest). Use for on-page `<Image>`. */
export function resolveMediaUrl(
  m: MediaUrlFields | null | undefined,
): string | null {
  if (!m) return null;
  return (
    normalizePublicUrl(
      firstNonEmpty(m.url_override, m.avif_url, m.webp_url, m.url, m.original_url),
      getCdnBaseSync(),
    ) ?? null
  );
}

/** EMAIL source — raster-first (jpg/png → webp), NEVER avif. Email clients can't
 *  negotiate formats or use a `<picture>` fallback, and several inboxes (notably
 *  Gmail) don't decode AVIF while Outlook needs plain JPG/PNG, so a logo `<img>`
 *  in a transactional email must point at the broadly-compatible variant. */
export function resolveEmailMediaUrl(
  m: MediaUrlFields | null | undefined,
): string | null {
  if (!m) return null;
  return (
    normalizePublicUrl(
      firstNonEmpty(m.url_override, m.url, m.webp_url, m.original_url),
      getCdnBaseSync(),
    ) ?? null
  );
}

/**
 * Thumbnail source — WEBP-first (compat). Some admin grids render this in a
 * raw `<img>` (no Next negotiation / no `<picture>` fallback), so it must
 * NOT be avif-first; webp is near-universal and the MediaPicker's `<Image>`
 * still up-negotiates webp→avif on-page.
 */
export function resolveMediaThumbUrl(
  m: MediaUrlFields | null | undefined,
): string | null {
  if (!m) return null;
  return (
    normalizePublicUrl(
      firstNonEmpty(m.url_override, m.webp_url, m.url, m.original_url),
      getCdnBaseSync(),
    ) ?? null
  );
}

/**
 * OG / JSON-LD / email-facing source — deliberately AVIF-AVOIDING so social
 * scrapers + email clients that can't render AVIF still get a working image.
 * Prefers WEBP (widely supported by modern crawlers) over the raw original.
 */
export function resolveMediaSocialUrl(
  m: MediaUrlFields | null | undefined,
): string | null {
  // Identical fallback chain to the thumbnail resolver (AVIF-avoiding,
  // webp-first). Delegated so the two stay in lock-step — see the doc
  // comment above for why both deliberately skip AVIF.
  return resolveMediaThumbUrl(m);
}
