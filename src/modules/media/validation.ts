/**
 * Médiathèque input validation — upload scopes + the per-image `url_override`.
 *
 * Deliberately framework-free (no `server-only`, no drizzle, no `process.env`
 * reads — the caller passes the host allow-list in) so the SAME rules back the
 * server actions and the client admin panel's scope picker, and are
 * unit-testable DB-free (media-safety.test.ts). Mirrors `./limits`.
 */

/**
 * Upload destinations. `buildStorageKey` interpolates the scope VERBATIM as the
 * S3 key prefix and the processor gates the products-only détourage on it, so an
 * unvalidated value would steer object placement and bypass that gate. The
 * Médiathèque Server Actions validate against this list; the two JSON routes
 * (/api/admin/media/upload + import-url) carry the same allow-list inline.
 */
export const MEDIA_UPLOAD_SCOPES = ["uploads", "products", "categories", "brands", "cms"] as const;

export type MediaUploadScope = (typeof MEDIA_UPLOAD_SCOPES)[number];

export function isMediaUploadScope(value: unknown): value is MediaUploadScope {
  return typeof value === "string" && (MEDIA_UPLOAD_SCOPES as readonly string[]).includes(value);
}

/** A validated scope, falling back to the neutral "uploads" (like the API routes). */
export function parseMediaUploadScope(value: unknown): MediaUploadScope {
  return isMediaUploadScope(value) ? value : "uploads";
}

type AllowedMediaBase = { protocol: string; host: string; prefix: string };

/**
 * Parse the media host allow-list SOURCES — the S3_PUBLIC_URL + MEDIA_CDN_URL
 * entries next/image `remotePatterns` and the CSP `img-src` were built from
 * (server callers pass `bakedMediaHostSources()` from ./cdn-allowlist). Keeps
 * scheme + host:port, since both remotePatterns and the CSP origin match them.
 */
function allowedMediaBases(sources: readonly string[]): AllowedMediaBase[] {
  const out: AllowedMediaBase[] = [];
  for (const v of sources) {
    const t = v?.trim();
    if (!t) continue;
    try {
      const u = new URL(t);
      out.push({
        protocol: u.protocol,
        host: u.host.toLowerCase(),
        prefix: u.pathname.replace(/\/+$/, ""),
      });
    } catch {
      /* skip a malformed entry (env validation reports it elsewhere) */
    }
  }
  return out;
}

const URL_OVERRIDE_MAX = 2000;

/**
 * Validate a Médiathèque `url_override` — the FIRST link of every media resolver
 * chain, so a bad value breaks the image everywhere it is used. Returns a French
 * field error, or `null` when acceptable. Empty/blank = "clear the override" = OK.
 *
 * Accepted:
 *   - a same-origin media proxy path `/cdn/<key>` (no `..`, no dot-led segment —
 *     the /cdn route rejects those with a 400);
 *   - an absolute http(s) URL whose scheme + host(:port) match one of the
 *     `allowSources` (the build-time S3_PUBLIC_URL / MEDIA_CDN_URL entries), with
 *     the path under that entry's path prefix — the exact shape next/image
 *     `remotePatterns` (`<prefix>/**`) and the CSP `img-src` origin allow. Same
 *     allow-list as `cdn_base_url`.
 * Rejected: `javascript:`/`data:`/other schemes, protocol-relative `//host`,
 * credentials in the URL, whitespace/control chars, foreign hosts.
 */
export function checkUrlOverride(
  raw: string | null | undefined,
  allowSources: readonly string[],
): string | null {
  const v = (raw ?? "").trim();
  if (v === "") return null;
  if (v.length > URL_OVERRIDE_MAX) return `URL trop longue (${URL_OVERRIDE_MAX} caractères maximum).`;
  // Whitespace, control chars and backslashes never belong in a media URL (and
  // `/\host` is a protocol-relative bypass in some parsers).
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f\\]/.test(v)) return "URL invalide (espaces ou caractères interdits).";

  if (v.startsWith("/")) {
    const segments = v.slice("/cdn/".length).split("/");
    const valid =
      v.startsWith("/cdn/") &&
      segments.every((s) => s !== "" && !s.startsWith(".") && !s.includes(".."));
    return valid
      ? null
      : "Chemin invalide — seul un chemin /cdn/<clé> de la médiathèque est accepté.";
  }

  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "URL invalide — utilisez https://… ou un chemin /cdn/….";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return "L'URL doit commencer par http:// ou https://.";
  }
  if (u.username || u.password) return "URL invalide (identifiants interdits dans l'URL).";

  const host = u.host.toLowerCase();
  const allowed = allowedMediaBases(allowSources).some(
    (a) =>
      a.protocol === u.protocol &&
      a.host === host &&
      (a.prefix === "" || u.pathname.startsWith(`${a.prefix}/`)),
  );
  if (!allowed) {
    return "Hôte non autorisé — utilisez un chemin /cdn/… ou une URL sous S3_PUBLIC_URL / MEDIA_CDN_URL (sinon next/image et la CSP bloquent l'image sur le storefront).";
  }
  return null;
}
