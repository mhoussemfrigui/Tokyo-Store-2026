import "server-only";

import { bakedMediaHostEntries, isCdnBaseAllowed } from "./cdn-allowlist";
import { mediaSettingsService } from "./settings.service";

/**
 * Effective CDN base resolver — single source of truth for "where do public
 * media URLs point".
 *
 * Precedence (highest → lowest):
 *   1. `media_settings.cdn_base_url`  — admin-editable (PRIMARY). Validated as
 *      a URL by the settings workflow; when set, every public `/cdn/<key>`
 *      path is rewritten to `<base>/<key>`.
 *   2. `MEDIA_CDN_URL` (env)          — deployment FALLBACK. Comma-separated;
 *      the first entry is used. Lets ops point at a CDN before an admin has
 *      filled the DB field.
 *   3. "" (empty)                     — DEFAULT: same-origin `/cdn` proxy.
 *
 * The URL resolvers (`resolveMediaUrl` & friends) and `normalizePublicUrl` are
 * SYNCHRONOUS and run per-row, so we can't `await` the settings row inside
 * them. Instead we memoise the resolved base in a module-level cache with a
 * short TTL and refresh it asynchronously via `primeCdnBase()`. Reads
 * (`getCdnBaseSync`) never block: until the DB value has been primed they fall
 * back to the env value (or empty), which is the correct precedence anyway.
 *
 * BUILD-TIME GATE: next/image remotePatterns + the CSP were compiled from the
 * BUILD's S3_PUBLIC_URL / MEDIA_CDN_URL (./cdn-allowlist). A candidate base (DB
 * or runtime env) whose host/path isn't in that baked list would break every
 * storefront image, so it is skipped with a one-time warning and resolution
 * falls through to the next source (ultimately the same-origin `/cdn` proxy,
 * which always works) until the image is rebuilt with that host.
 */

const CACHE_TTL_MS = 30_000;

type CacheEntry = { base: string; expiresAt: number };
let cached: CacheEntry | null = null;
let inflight: Promise<string> | null = null;

const warnedBases = new Set<string>();

/** `base` when the build's host allow-list covers it, else "" (warned once). */
function gateToBuild(base: string, source: string): string {
  if (!base || isCdnBaseAllowed(base, bakedMediaHostEntries())) return base;
  if (!warnedBases.has(base)) {
    warnedBases.add(base);
    console.warn(
      `[media] ${source} "${base}" is not in this build's media host allow-list ` +
        "(S3_PUBLIC_URL / MEDIA_CDN_URL at `next build`) — ignored so next/image + the CSP " +
        "don't block storefront images. Rebuild with MEDIA_CDN_URL as a build argument to use it.",
    );
  }
  return "";
}

/** First non-empty `MEDIA_CDN_URL` entry, normalised (no trailing slash). */
function envCdnBase(): string {
  const raw = process.env.MEDIA_CDN_URL;
  if (!raw) return "";
  const first = raw.split(",").map((s) => s.trim()).find(Boolean);
  return gateToBuild(first ? first.replace(/\/+$/, "") : "", "MEDIA_CDN_URL");
}

/** Normalise a candidate base: trim + strip trailing slash. */
function normaliseBase(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : "";
}

/**
 * Synchronous read of the effective CDN base. Returns the last primed DB value
 * when fresh; otherwise the env fallback (or "" for the same-origin proxy).
 * Never blocks and never throws.
 */
export function getCdnBaseSync(): string {
  if (cached && cached.expiresAt > Date.now()) return cached.base;
  // Not primed yet (or expired) — fall back to env so precedence still holds:
  // DB-primed value wins once available, env covers the gap, "" is default.
  return envCdnBase();
}

/**
 * Asynchronously resolve + memoise the effective CDN base from the DB
 * (`media_settings.cdn_base_url`), falling back to env. Safe to call on every
 * server request that resolves media URLs — it dedupes concurrent calls and
 * only hits the (already-cached) settings service when the TTL lapses.
 *
 * Call this once before a batch of sync `resolveMediaUrl(...)` calls in a
 * server component / loader to guarantee `getCdnBaseSync()` sees the DB value.
 */
export async function primeCdnBase(): Promise<string> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.base;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const settings = await mediaSettingsService.get();
      const base =
        gateToBuild(normaliseBase(settings.cdn_base_url), "media_settings.cdn_base_url") ||
        envCdnBase();
      cached = { base, expiresAt: Date.now() + CACHE_TTL_MS };
      return base;
    } catch {
      // DB unreachable — degrade to env so URLs still resolve. Don't cache a
      // failure: retry on the next call.
      return envCdnBase();
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Force the next read to re-resolve (used when settings change). */
export function invalidateCdnBase(): void {
  cached = null;
}
