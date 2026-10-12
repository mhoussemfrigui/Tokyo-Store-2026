import "server-only";

import { NextResponse } from "next/server";

/**
 * Same-origin guard for FIRST-PARTY browser routes (storefront search,
 * funnel tracking). These are called only by our own pages via `fetch()`,
 * never by external clients — those use the key-gated `/api/*` data surface.
 * This is the "internal vs external" boundary: first-party = same-origin, no
 * key; external = scoped key.
 *
 * This is a CSRF / cross-origin-abuse speed-bump, NOT authentication. It stops
 * a real browser on another origin from calling these routes, but a non-browser
 * client (curl, a server) can trivially send a matching `Sec-Fetch-Site` /
 * Origin / Referer and pass — so it must NEVER be the sole guard on anything
 * sensitive or state-changing. The real controls here are the per-IP rate limit
 * + (for /api/track) the consent gate; both are independent of this check.
 *
 * Decision order:
 *   1. `Sec-Fetch-Site` (a forbidden header that in-page browser JS cannot set):
 *      allow `same-origin`/`same-site`; refuse `cross-site` and `none`
 *      (direct navigation / non-browser).
 *   2. Fallback for callers without that header: the Origin/Referer host must
 *      equal the request Host.
 *   3. No usable signal at all → refuse (a bare server-to-server / curl call).
 */
export function isFirstParty(req: Request): boolean {
  const secSite = req.headers.get("sec-fetch-site");
  if (secSite) return secSite === "same-origin" || secSite === "same-site";

  const host = req.headers.get("host");
  const candidate = req.headers.get("origin") ?? req.headers.get("referer");
  if (!host || !candidate) return false;
  try {
    return new URL(candidate).host === host;
  } catch {
    return false;
  }
}

/** Returns a 403 response to short-circuit a non-first-party call, else null. */
export function requireFirstParty(req: Request): NextResponse | null {
  if (isFirstParty(req)) return null;
  return NextResponse.json(
    { error: "Origine non autorisée." },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}
