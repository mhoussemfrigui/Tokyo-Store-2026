import "server-only";

import { NextResponse } from "next/server";

import { serverEnv } from "@/lib/env";

/**
 * CSRF defense for admin POST routes.
 *
 * Better Auth's `trustedOrigins` only protects `/api/auth/*`. Other admin
 * endpoints (`/api/admin/media/upload`, `/api/admin/system/demo`, …) were
 * previously reachable from any origin as long as the admin's session cookie
 * was present. `SameSite=Lax` cookies block top-level cross-site navigation
 * but **allow** credentialed XHR/fetch in many browsers, so a malicious tab
 * could trigger admin actions while the operator is logged in.
 *
 * This helper builds the set of allowed origins from env at request time:
 *
 *   - `BETTER_AUTH_URL` — the canonical Better Auth origin
 *   - `NEXT_PUBLIC_SITE_URL` — what the storefront uses
 *   - `BETTER_AUTH_TRUSTED_ORIGINS` — operator CSV escape hatch
 *
 * It compares the request's `Origin` header (or `Referer` host as a fallback)
 * against that set. Mismatches return 403 with no body so probing scripts
 * get nothing back.
 *
 * Same-origin GET requests don't always send `Origin` (browsers omit it for
 * "safe" methods to dodge tracking). For state-changing POST/PUT/PATCH/DELETE,
 * modern browsers always include `Origin`. We treat missing-Origin on those
 * methods as a hard reject — there's no legitimate same-origin POST without
 * an Origin header.
 */

function buildAllowedOrigins(): Set<string> {
  const allowed = new Set<string>();
  if (serverEnv.BETTER_AUTH_URL) {
    allowed.add(normalize(serverEnv.BETTER_AUTH_URL));
  }
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (siteUrl) allowed.add(normalize(siteUrl));
  const extra = process.env.BETTER_AUTH_TRUSTED_ORIGINS;
  if (extra) {
    for (const o of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
      allowed.add(normalize(o));
    }
  }
  return allowed;
}

function normalize(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return url;
  }
}

export function assertSameOrigin(request: Request): NextResponse | null {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");

  // For state-changing methods we REQUIRE an Origin header. Modern browsers
  // always send it; the only callers who don't are scripts / replay tools.
  const method = request.method.toUpperCase();
  const isStateChanging =
    method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";

  if (!origin && !referer && isStateChanging) {
    return NextResponse.json(
      { error: { code: "forbidden", message: "Origin header required" } },
      { status: 403 },
    );
  }

  const candidate = origin
    ? normalize(origin)
    : referer
      ? normalize(referer)
      : null;
  if (!candidate) return null; // GETs can fall through

  const allowed = buildAllowedOrigins();
  if (!allowed.has(candidate)) {
    return NextResponse.json(
      { error: { code: "forbidden", message: "Origin not trusted" } },
      { status: 403 },
    );
  }
  return null;
}
