/**
 * Runtime URL normalizer — belt-and-braces fallback for any image / media
 * URL stored as an absolute URL instead of a relative `/cdn/<key>` path.
 *
 * Media rows normally store relative `/cdn/...` paths (`publicUrlFor()`), but
 * a few escape hatches still produce absolute URLs: a manually pasted URL in
 * `url_override`, a user-provided URL flowing through `users.image` from an
 * OAuth account, demo fixtures that hard-code a full URL, etc.
 *
 *   The result: even a "rogue" `http://localhost:9100/tokyo/foo.webp`
 *   in the DB still ends up served via the same-origin `/cdn` proxy.
 *
 *   External / real-CDN URLs (Google avatars, third-party media) are left
 *   alone — we only rewrite URLs that look like ours.
 *
 * "Ours" heuristic:
 *   1. Anything already starting with `/cdn/` — pass through (cheap path)
 *   2. Anything starting with another absolute path (`/...`) — pass through
 *   3. Empty / null — pass through (caller handles the empty case)
 *   4. http(s) URL whose hostname matches a known-local pattern
 *      (localhost / 127.0.0.1 / private IP / docker hostname / configured
 *      S3 public hostname): strip scheme+host+bucket → `/cdn/<key>`
 *   5. Otherwise (real external URL): pass through
 */

/**
 * Local-ish hostnames produced by our own infra. Anything matching these
 * gets normalised; everything else is treated as an external URL the user
 * legitimately wants to serve verbatim.
 */
function isLocalLikeHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "127.0.0.1" || h === "0.0.0.0" || h === "::1") return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  // Docker / k8s-style internal names: no dots, or ends with .local/.svc/.internal
  if (!h.includes(".")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".svc")) {
    return true;
  }
  return false;
}

/**
 * Apply an effective CDN base to a same-origin `/cdn/<key>` proxy path.
 *
 *   - `cdnBase` empty  → leave the path same-origin (default `/cdn` proxy).
 *   - `cdnBase` set    → rewrite `/cdn/<key>` → `<cdnBase>/<key>`.
 *
 * The base is resolved server-side once per request (DB `cdn_base_url` →
 * `MEDIA_CDN_URL` env → "") and threaded in by the media URL resolvers, so this
 * helper stays synchronous and side-effect-free. Only `/cdn/`-prefixed paths
 * are rewritten — absolute URLs and other relative paths pass through.
 */
function applyCdnBase(path: string, cdnBase: string): string {
  if (!cdnBase || !path.startsWith("/cdn/")) return path;
  const key = path.slice("/cdn/".length);
  return `${cdnBase.replace(/\/+$/, "")}/${key}`;
}

/**
 * Normalise any image/media URL to a `/cdn/...` path when possible, then
 * (optionally) rewrite that path through the effective CDN base. Returns the
 * input unchanged for real external URLs, empty values, and inputs that are
 * already non-`/cdn` relative paths.
 *
 * @param cdnBase Effective CDN base (DB `cdn_base_url` → `MEDIA_CDN_URL` env →
 *   ""). When empty, output stays same-origin `/cdn/...`. Resolved by the media
 *   layer (`getCdnBaseSync`) and threaded in so this stays synchronous.
 */
export function normalizePublicUrl(
  input: string | null | undefined,
  cdnBase = "",
): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;

  // Already a same-origin proxy path — route it through the CDN base if set.
  if (trimmed.startsWith("/cdn/")) return applyCdnBase(trimmed, cdnBase);
  // Any other absolute path — leave alone.
  if (trimmed.startsWith("/")) return trimmed;
  // Data / blob URIs — pass through.
  if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) {
    return trimmed;
  }

  // From here we need a parsable absolute URL.
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed; // unparseable; let downstream handle the breakage visibly
  }

  // Build the bucket name from S3_BUCKET if available; otherwise accept any
  // single path segment as the bucket. We do *not* hard-code "tokyo" so
  // staging / prod with a different bucket name still works.
  const envBucket = process.env.S3_BUCKET;
  const segments = u.pathname.replace(/^\/+/, "").split("/");
  if (segments.length < 2) {
    // Not a `<host>/<bucket>/<key>` shape — leave alone.
    return trimmed;
  }
  const [bucket, ...rest] = segments;
  if (envBucket && bucket !== envBucket) {
    // Looks like an external host that happens to have a different first
    // segment — not ours. Leave alone.
    return trimmed;
  }

  // Only rewrite local-ish hosts. Real CDN domains stay as-is so an admin
  // who genuinely points `url_override` at an external CDN keeps working.
  if (!isLocalLikeHost(u.hostname)) {
    return trimmed;
  }

  const key = rest.map(decodeURIComponent).map(encodeURIComponent).join("/");
  return applyCdnBase(`/cdn/${key}`, cdnBase);
}
