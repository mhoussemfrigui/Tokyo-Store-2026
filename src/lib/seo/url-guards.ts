/**
 * PURE URL guards for the SEO layer (no DB / no server-only → unit-tested in
 * db/tests/seo-url-guards.test.ts):
 *   - `hasForeignCanonical` — does an entity's canonical override point AWAY
 *     from its own URL? (the sitemap must only list self-canonical URLs);
 *   - `validateSiteUrlInput` / `siteUrlChangeRefused` — the `seo.site_url`
 *     write policy. That one setting is the origin of payment return / callback
 *     URLs, every email link, B2B invite links and printed order QR codes
 *     (lib/url/public-origin.ts), so it must be a bare https origin and only the
 *     owner (`*`) may change it.
 */

/** The `seo.site_url` setting key (owner-only — see saveSeoSettingsAction). */
export const SITE_URL_KEY = "seo.site_url";

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/**
 * True when `canonical` (an admin override, absolute or site-relative) resolves
 * to a DIFFERENT URL than `selfUrl` (the entity's own absolute URL). Empty →
 * false (no override = self-canonical). An unparseable value is left alone
 * (false) — it can't point anywhere definite. Host case and a trailing slash are
 * ignored; the query string counts (a canonical with a query is another URL).
 */
export function hasForeignCanonical(canonical: string | null | undefined, selfUrl: string): boolean {
  const c = (canonical ?? "").trim();
  if (!c) return false;
  try {
    const self = new URL(selfUrl);
    const target = new URL(c, self);
    return (
      target.origin !== self.origin ||
      trimSlash(target.pathname) !== trimSlash(self.pathname) ||
      target.search !== self.search
    );
  } catch {
    return false;
  }
}

/** Loopback hosts where plain http is acceptable (local dev). */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Validate + normalize a `seo.site_url` input to a BARE ORIGIN
 * (`https://host[:port]`). Empty is allowed (→ "" = fall back to the build-time
 * NEXT_PUBLIC_SITE_URL). Requires https (plain http only for localhost), and
 * refuses credentials, a path, a query or a fragment — every consumer appends
 * `/order/…`, `/admin/…` to it, so anything but an origin would corrupt them.
 */
export function validateSiteUrlInput(
  raw: string | null | undefined,
): { ok: true; value: string } | { ok: false; message: string } {
  const v = (raw ?? "").trim();
  if (!v) return { ok: true, value: "" };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { ok: false, message: "URL du site invalide — attendu : https://votre-domaine.tn" };
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLoopbackHost(u.hostname))) {
    return {
      ok: false,
      message: "L'URL du site doit être en https:// (http n'est accepté que pour localhost).",
    };
  }
  if (u.username || u.password) {
    return { ok: false, message: "L'URL du site ne doit pas contenir d'identifiants." };
  }
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) {
    return {
      ok: false,
      message: "L'URL du site doit être le domaine seul (sans chemin, paramètre ni ancre), ex. https://votre-domaine.tn",
    };
  }
  return { ok: true, value: u.origin };
}

/** Comparable form of a stored / posted site URL (trimmed, no trailing slash). */
function comparableSiteUrl(v: string | null | undefined): string {
  return (v ?? "").trim().replace(/\/+$/, "");
}

/**
 * Does this save CHANGE `seo.site_url`? `posted` is null when the form didn't
 * carry the field (a disabled input isn't submitted). Only a change is
 * validated / owner-gated, so a legacy stored value never blocks an unrelated
 * SEO save.
 */
export function isSiteUrlChange(posted: string | null, stored: string | null | undefined): boolean {
  return posted !== null && comparableSiteUrl(posted) !== comparableSiteUrl(stored);
}

/**
 * Must a `seo.site_url` save be REFUSED? Only the owner (`*`) may change it. A
 * delegate's form renders the field disabled (so it isn't posted at all → the
 * stored value is kept, not refused); a crafted post of a DIFFERENT value is
 * refused, an identical one is harmless.
 */
export function siteUrlChangeRefused(
  isOwner: boolean,
  posted: string | null,
  stored: string | null | undefined,
): boolean {
  return !isOwner && isSiteUrlChange(posted, stored);
}
