import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import {
  ADMIN_LOGIN_INTERNAL_PATH,
  ADMIN_LOGIN_IS_CUSTOM,
  ADMIN_LOGIN_PATH,
} from "@/lib/auth/admin-path";
import { markdownEligible } from "@/lib/seo/markdown/eligible";
import { SITE_PATH_HEADER } from "@/lib/site-mode/gate-exempt";

/**
 * Proxy (Next 16's middleware replacement) — runs on the Edge runtime.
 *
 * Three jobs, all env/cookie-only (NO DB — authorisation still happens in the
 * page via requireSession() / requirePermission()). The in-body `── (n)` markers
 * match this numbering:
 *
 *  1. SEPARATE CONNECTION POINTS. `/account` (customers) and `/admin` (staff)
 *     both require a session cookie. Missing on `/account` → 302 to `/login`.
 *     Missing on `/admin`: if a SECRET `ADMIN_LOGIN_PATH` is set we 404 (a
 *     redirect would leak the secret slug in the Location header — staff reach
 *     the login via the secret path directly); with the default `/admin-login`
 *     we 302 there for convenience. We don't decode the cookie here (that'd cost
 *     a DB round-trip per request) — real authz is the RBAC gate in the page.
 *
 *  2. EDITABLE ADMIN-LOGIN URL. The staff login physically lives at
 *     `/admin-login`. When an operator sets a secret `ADMIN_LOGIN_PATH`, this
 *     rewrites that secret path to the physical route AND 404s the physical
 *     default — so the secret path becomes the only working entry.
 *
 *  3. MARKDOWN FOR AGENTS. A markdown-shaped request (a `.md` suffix or
 *     `Accept: text/markdown`) for an eligible path is rewritten to the node
 *     `/md` route (which enforces the SEO toggle). Normal browsers/Googlebot
 *     (Accept: text/html, no `.md`) are never matched.
 *
 * Every forwarded request also carries the pathname in SITE_PATH_HEADER (see
 * `forwardedHeaders`) for the (shop) layout's maintenance-gate exemptions.
 *
 * Better Auth cookies are prefixed `gz.` (advanced.cookiePrefix in auth/server).
 */

const SESSION_COOKIE = "gz.session_token";
const SECURE_SESSION_COOKIE = "__Secure-gz.session_token";

function hasSessionCookie(req: NextRequest): boolean {
  return Boolean(
    req.cookies.get(SESSION_COOKIE)?.value ||
      req.cookies.get(SECURE_SESSION_COOKIE)?.value,
  );
}

/**
 * Request headers forwarded to the app, with the pathname stamped under
 * SITE_PATH_HEADER so the (shop) layout can exempt the auth / unsubscribe pages
 * from the maintenance gate (it can't see the pathname otherwise). ALWAYS set
 * from `request.nextUrl.pathname` on a CLONE — a client-supplied value is
 * overwritten, so it can never spoof an exemption.
 */
function forwardedHeaders(request: NextRequest, pathname: string): Headers {
  const headers = new Headers(request.headers);
  headers.set(SITE_PATH_HEADER, pathname);
  return headers;
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── (2) Secret admin-login path (only when an operator customised it) ──
  if (ADMIN_LOGIN_IS_CUSTOM) {
    if (pathname === ADMIN_LOGIN_PATH) {
      const url = request.nextUrl.clone();
      url.pathname = ADMIN_LOGIN_INTERNAL_PATH;
      return NextResponse.rewrite(url, {
        request: { headers: forwardedHeaders(request, pathname) },
      });
    }
    if (pathname === ADMIN_LOGIN_INTERNAL_PATH) {
      // Hide the default route so only the secret path works.
      return new NextResponse(null, { status: 404 });
    }
  }

  // ── (3) Markdown for agents: content negotiation ──
  // Rewrite a markdown-shaped request (`.md` suffix OR `Accept: text/markdown`) to
  // the node /md route, which generates from the data layer + enforces the SEO
  // toggle. Edge can't read the DB, so it always rewrites; the route 404s when the
  // feature is off. A normal browser (Accept: text/html, no .md) is NEVER matched,
  // so humans + Googlebot are unaffected.
  {
    const isMdSuffix = pathname.endsWith(".md");
    const acceptsMd = (request.headers.get("accept") ?? "").includes("text/markdown");
    if (isMdSuffix || acceptsMd) {
      const clean = isMdSuffix ? pathname.slice(0, -3) || "/" : pathname;
      if (markdownEligible(clean)) {
        const url = request.nextUrl.clone();
        url.pathname = `/md${clean}`; // clean has a leading slash → /md/blog/foo
        return NextResponse.rewrite(url, {
          request: { headers: forwardedHeaders(request, pathname) },
        });
      }
      // A .md suffix on an ineligible path falls through to a normal 404.
    }
  }

  // ── (1) Cookie gate for protected segments ──
  // Match the /admin SEGMENT precisely — `/admin-login` must NOT count
  // (it's the unauthenticated entry point; gating it would loop).
  const isAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  const isAccount = pathname === "/account" || pathname.startsWith("/account/");

  if (isAdmin && !hasSessionCookie(request)) {
    // When a SECRET admin-login path is configured, DON'T redirect /admin to it:
    // the `Location` header would leak the secret slug to anyone who probes
    // /admin, defeating the whole point of a secret entry. 404 instead so the
    // admin segment is fully undiscoverable; staff reach the login via the secret
    // path directly (known out-of-band). With the default (non-secret)
    // /admin-login there's nothing to hide, so redirect for convenience.
    if (ADMIN_LOGIN_IS_CUSTOM) {
      return new NextResponse(null, { status: 404 });
    }
    const url = request.nextUrl.clone();
    url.pathname = ADMIN_LOGIN_PATH;
    url.search = `?from=${encodeURIComponent(pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }

  if (isAccount && !hasSessionCookie(request)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?from=${encodeURIComponent(pathname + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next({ request: { headers: forwardedHeaders(request, pathname) } });
}

export const config = {
  matcher: [
    /*
     * Match all paths except Next internals, static assets, the auth API
     * (which must stay open so users can sign in/out), and metadata routes.
     */
    "/((?!_next/static|_next/image|favicon.ico|images/|api/auth|robots.txt|sitemap.xml).*)",
  ],
};
