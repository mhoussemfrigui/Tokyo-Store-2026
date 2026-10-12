/**
 * PURE (no server-only / no DB / no next import) — the maintenance / coming-soon
 * gate's path allow-list, shared by the Edge proxy (which stamps the request
 * pathname header), the (shop) layout (which reads it) and the client nav guard.
 *
 * WHY: the auth continuation pages and the unsubscribe page live under the
 * gated (shop) layout, but they must keep working while the storefront is
 * closed — otherwise a TOTP-enabled admin can't finish /admin-login (it
 * redirects to /login/2fa), invite / password-reset links (→ /reset-password)
 * dead-end, and marketing recipients can't opt out (/se-desabonner) while mail
 * keeps flowing. None of these pages render catalogue data.
 */

/** Request header carrying the pathname, ALWAYS overwritten by src/proxy.ts
 *  from `request.nextUrl.pathname` — a client-supplied value never survives on
 *  a proxied path, so it can't be spoofed to skip the gate. */
export const SITE_PATH_HEADER = "x-tokyo-pathname";

/** Exempt base paths; each also exempts its sub-paths (`/login` ⇒ `/login/2fa`).
 *  `/register` (and the rest of the store) stays gated on purpose. */
export const SITE_GATE_EXEMPT_PATHS = [
  "/login",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/se-desabonner",
] as const;

/**
 * Is `pathname` exempt from the storefront gate? Exact base or a sub-path
 * (segment boundary — `/login-x` / `/reset-passwordX` do NOT match); trailing
 * slashes ignored. A missing header (null / "") is NOT exempt, so a request that
 * bypassed the proxy keeps today's gated behaviour.
 */
export function isSiteGateExemptPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  const p = pathname.replace(/\/+$/, "") || "/";
  return SITE_GATE_EXEMPT_PATHS.some((base) => p === base || p.startsWith(`${base}/`));
}
