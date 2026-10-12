/**
 * Same-origin proxy for the S3 object store (SeaweedFS S3 gateway).
 *
 * Why this exists:
 *   - Next.js 16 blocks loopback / private-IP image fetches by default
 *     (SSRF guard). Even with `dangerouslyAllowLocalIP: true`, the app
 *     container can't reach the browser-facing `localhost:8333` mapping —
 *     from inside the container, the store lives at `seaweedfs:8333`.
 *   - Browsers and server-side image optimization need a hostname both
 *     can resolve. Same-origin solves it: the browser hits the app, the
 *     app proxies to `S3_ENDPOINT` (internal docker hostname).
 *
 * Browser-facing URL:   /cdn/<key>           (e.g. /cdn/cms/abc.webp)
 * Internal fetched URL: ${S3_ENDPOINT}/${S3_BUCKET}/<key>
 *
 * Public images only — no auth, no presigning (sole exception: kept
 * `.original.` sources, staff-only — see KEPT_ORIGINAL_RE). The store's
 * `anonymous` identity grants unauthenticated read (GetObject/HeadObject) on
 * these keys, so this proxy fetches them UNSIGNED; we just relay them through
 * the app origin so:
 *   - `next/image` can fetch + transcode them (same-origin = always allowed)
 *   - CSP only needs `img-src 'self'`
 *   - No CORS dance, no external object-store hostname leakage to the browser
 *   - Coolify deploys with an internal-only object store still work
 *
 * Caching: a SUCCESS body is long-immutable — storage keys are random-UUID
 * -prefixed so a key never changes meaning, making the 1-year `immutable`
 * directive safe. Error statuses are NEVER cached (a transient 503/403 must
 * not become a permanently-broken image).
 */

import { NextRequest, NextResponse } from "next/server";

import { serverEnv } from "@/lib/env";

/**
 * Kept originals (`<base>.original.<ext>`, written when `keep_original` is on)
 * are never a storefront URL — every resolver chain reaches `url` (NOT NULL)
 * before `original_url`, and GIF originals live at the primary key, not here.
 * Their only consumer is the Médiathèque « Orig. » chip. They are the full-
 * resolution source (and one stored before EXIF stripping applied to originals,
 * or with `strip_exif` off, carries the upload's full EXIF — GPS, device), so an
 * anonymous caller who derives the sibling key from a public image URL gets a
 * 404; a staff session holding `media:view` can still open them (never cached
 * publicly). Defence in depth only: the processor now stores originals
 * metadata-free when `strip_exif` is on.
 */
const KEPT_ORIGINAL_RE = /\.original\.[a-z0-9]+$/i;

async function canViewKeptOriginals(): Promise<boolean> {
  try {
    // Lazy: keep the auth/RBAC stack off the anonymous image hot path.
    const [{ getSession }, { resolveUserPermissions, permissionSetAllows }] = await Promise.all([
      import("@/lib/auth/session"),
      import("@/lib/rbac/authorize"),
    ]);
    const session = await getSession();
    if (!session?.user) return false;
    const perms = await resolveUserPermissions(session.user.id);
    return permissionSetAllows(perms, "media", "view");
  } catch {
    return false;
  }
}

// Range / conditional headers we'll forward in both directions so the
// browser still gets seekable video + 304s for cached images.
const REQUEST_PASS_THROUGH = [
  "range",
  "if-none-match",
  "if-modified-since",
  "accept-encoding",
];

const RESPONSE_PASS_THROUGH = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "etag",
  "last-modified",
];

/**
 * Proxy a single object request to the object store. `method` is forwarded verbatim, so a
 * HEAD probe issues an upstream HeadObject (no body fetched) instead of pulling
 * + discarding the full object.
 */
async function proxy(req: NextRequest, path: string[], method: "GET" | "HEAD"): Promise<Response> {
  if (!path || path.length === 0) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Normalise + reject traversal. Each segment must not start with a dot
  // and must not contain control chars. Re-join with `/`.
  for (const seg of path) {
    if (seg.startsWith(".") || seg.includes("..") || seg.includes("\0")) {
      return new NextResponse("Bad request", { status: 400 });
    }
  }
  const keptOriginal = KEPT_ORIGINAL_RE.test(path[path.length - 1]);
  if (keptOriginal && !(await canViewKeptOriginals())) {
    return new NextResponse("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const key = path.map(encodeURIComponent).join("/");

  const upstream = `${serverEnv.S3_ENDPOINT.replace(/\/$/, "")}/${serverEnv.S3_BUCKET}/${key}`;

  const headers = new Headers();
  for (const h of REQUEST_PASS_THROUGH) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }

  // 10s bound on TIME-TO-FIRST-BYTE only — NOT the body relay. A plain
  // `AbortSignal.timeout` on the fetch keeps firing while the response body
  // streams, so a large/slow download (a direct /cdn link, browser "save
  // image/video", a crawler og:image, a multi-MB asset on a slow connection) was
  // aborted mid-stream and truncated. Clear the deadline as soon as fetch()
  // settles (headers received); the body then streams without an absolute cap.
  // The object store is on the same docker network, so a slow HEADER phase is still a real
  // problem worth surfacing as a 502.
  const ac = new AbortController();
  const headerTimeout = setTimeout(() => ac.abort(new Error("cdn-upstream-timeout")), 10_000);
  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstream, {
      method,
      headers,
      // The object TTL is long; we don't want Next.js's fetch
      // cache to hold them in memory — let the HTTP cache headers govern.
      cache: "no-store",
      // Never auto-follow an upstream redirect. The upstream host is
      // app-controlled, but defence-in-depth: a misconfig / compromised bucket
      // policy returning a 3xx must not make this proxy fetch an arbitrary
      // origin on behalf of an anonymous caller. A 3xx is handled as 502 below.
      redirect: "manual",
      signal: ac.signal,
    });
  } catch (err) {
    // Log full diagnostics server-side, but return a GENERIC body — the raw
    // error leaks the internal object-store hostname/IP to this anonymous endpoint.
    console.error("[cdn] upstream fetch failed:", err instanceof Error ? err.message : "unknown");
    return new NextResponse("Bad gateway", { status: 502 });
  } finally {
    // Headers are in (or the fetch threw): stop the deadline so it can never
    // abort the streamed body below.
    clearTimeout(headerTimeout);
  }

  if (upstreamRes.status === 404) {
    // Cancel the (empty) body stream so the undici connection returns to the pool.
    upstreamRes.body?.cancel().catch(() => {});
    return new NextResponse("Not found", { status: 404 });
  }

  // An upstream redirect (redirect:"manual" above leaves 3xx unfollowed) is not
  // a valid object response — surface it as a bad gateway rather than relaying a
  // Location to an anonymous client.
  if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
    upstreamRes.body?.cancel().catch(() => {});
    return new NextResponse("Bad gateway", { status: 502 });
  }

  const out = new Headers();
  for (const h of RESPONSE_PASS_THROUGH) {
    const v = upstreamRes.headers.get(h);
    if (v) out.set(h, v);
  }
  // Long-immutable cache ONLY for a successful object (200-299, incl. 206 partial)
  // or a 304. Any other status (403 during a policy edit, 416 bad Range, 503 on a
  // object-store restart) must NOT be cached, or `immutable` turns a transient blip into
  // a permanently-broken image with no revalidation.
  if (keptOriginal) {
    // Staff-only object: never let a shared cache/CDN store it for anonymous reuse.
    out.set("Cache-Control", "private, no-store");
  } else if (upstreamRes.ok || upstreamRes.status === 304) {
    out.set("Cache-Control", "public, max-age=31536000, immutable");
  } else {
    out.set("Cache-Control", "no-store");
  }

  // For HEAD, drop the body but keep headers + status (and release the stream).
  if (method === "HEAD") {
    upstreamRes.body?.cancel().catch(() => {});
    return new Response(null, { status: upstreamRes.status, headers: out });
  }
  return new Response(upstreamRes.body, { status: upstreamRes.status, headers: out });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  return proxy(req, (await params).path, "GET");
}

// Cheap HEAD support so `<img>` and CDN probes don't download bytes — forwards a
// real upstream HEAD (HeadObject), so no object body is fetched on either leg.
export async function HEAD(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  return proxy(req, (await params).path, "HEAD");
}
