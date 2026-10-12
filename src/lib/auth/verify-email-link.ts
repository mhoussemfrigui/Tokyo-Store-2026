/**
 * PURE helpers for Better Auth's emailed verification links (no deps —
 * unit-testable).
 *
 * Better Auth builds every verification link as
 * `<BETTER_AUTH_URL>/api/auth/verify-email?token=<jwt>&callbackURL=<path>` and,
 * after handling the click, REDIRECTS to `callbackURL` — on success as-is, on a
 * bad/expired token with `?error=<CODE>` (or `&error=` when the callback already
 * carries a query). With no callback it defaults to `/`, which dropped the
 * customer silently on the home page (an expired link said nothing) and left the
 * storefront `/verify-email` result page unreachable.
 */

/**
 * Where a clicked verification link lands (the (shop)/verify-email page). The
 * `confirmed=1` marker tells a completed verification apart from a bare visit
 * (which renders the « lien incomplet » copy); an error redirect arrives as
 * `/verify-email?confirmed=1&error=TOKEN_EXPIRED`, and the page lets the error win.
 */
export const VERIFY_EMAIL_RESULT_PATH = "/verify-email?confirmed=1";

/**
 * Point a Better Auth verification link at the storefront result page when it
 * carries no explicit callback (Better Auth's `/` default). A caller-chosen
 * callback (e.g. the change-email flow's `/account`) is kept. Returns the input
 * unchanged when it isn't a parseable absolute URL.
 */
export function withVerifyEmailCallback(url: string, callbackPath: string = VERIFY_EMAIL_RESULT_PATH): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const current = parsed.searchParams.get("callbackURL");
  if (current && current !== "/") return url;
  parsed.searchParams.set("callbackURL", callbackPath);
  return parsed.toString();
}

/**
 * The OLD → NEW address pair carried by a change-email verification token
 * (`{ email: <current>, updateTo: <new> }`), or null for any other token (a plain
 * signup verification has no `updateTo`). Only DECODES the JWT payload — it does
 * not check the signature, so callers must only use it where Better Auth has
 * already verified the token (the `/verify-email` endpoint verifies it before it
 * writes anything, and the user-update hook that reads this runs after that write).
 */
export function readChangeEmailClaim(token: unknown): { oldEmail: string; newEmail: string } | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const { email, updateTo } = payload as { email?: unknown; updateTo?: unknown };
  if (typeof email !== "string" || typeof updateTo !== "string") return null;
  const oldEmail = email.trim().toLowerCase();
  const newEmail = updateTo.trim().toLowerCase();
  if (!oldEmail || !newEmail || oldEmail === newEmail) return null;
  return { oldEmail, newEmail };
}
