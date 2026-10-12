/**
 * Admin / staff login path configuration.
 *
 * EDGE-SAFE BY CONTRACT: this module is imported by `src/proxy.ts` (Next 16's
 * middleware replacement), which runs on the Edge runtime. It must therefore
 * contain ONLY `process.env` reads
 * and pure string logic — never import "server-only", the DB, Node APIs, or any
 * module that transitively does.
 *
 * The physical staff-login route lives at `/admin-login` (a sibling of the
 * gated `/admin/*` segment, so an unauthenticated visitor can actually reach
 * it). Operators can expose it at a SECRET path by setting `ADMIN_LOGIN_PATH`
 * (e.g. "/staff-x7k2") in the environment; middleware then rewrites that path
 * to the physical route AND 404s the physical default, so the secret path is
 * the only working entry. Customer login (`/login`) is unaffected.
 */

/** The physical route folder under `src/app`. Never changes. */
export const ADMIN_LOGIN_INTERNAL_PATH = "/admin-login";

/** Validate an operator-supplied path: one leading slash, then only safe
 *  path chars. Anything off → fall back to the internal default (fail safe). */
function sanitizeLoginPath(raw: string | undefined): string {
  if (!raw) return ADMIN_LOGIN_INTERNAL_PATH;
  const v = raw.trim();
  if (!/^\/(?![/\\])[A-Za-z0-9/_-]*$/.test(v)) return ADMIN_LOGIN_INTERNAL_PATH;
  const trimmed = v.replace(/\/+$/, ""); // drop trailing slash(es)
  return trimmed || ADMIN_LOGIN_INTERNAL_PATH;
}

/** The PUBLIC path where the staff login is reachable (default or secret). */
export const ADMIN_LOGIN_PATH = sanitizeLoginPath(process.env.ADMIN_LOGIN_PATH);

/** True when an operator configured a custom secret path (≠ the default). */
export const ADMIN_LOGIN_IS_CUSTOM = ADMIN_LOGIN_PATH !== ADMIN_LOGIN_INTERNAL_PATH;
