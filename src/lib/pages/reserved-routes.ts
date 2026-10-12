/**
 * SINGLE SOURCE OF TRUTH for the first-level URL names the file-based routes own.
 * Isomorphic (no `server-only`, no DB) so the slug checker (server), the redirect
 * coverage helper (lib/redirects/normalize.ts, also bundled in the admin client)
 * and the pure drift test (db/tests/reserved-routes.test.ts) share ONE list.
 *
 * Every entity that sits on the flat `/[slug]` namespace (CMS pages, categories,
 * products, brands) must avoid these names: a file route always wins over the
 * dynamic `(shop)/[slug]` resolver, so a colliding slug would be unreachable.
 *
 * ADDING A FIRST-LEVEL ROUTE (a new `src/app/<name>/` or `src/app/(group)/<name>/`
 * directory) ⇒ add it here. reserved-routes.test.ts fails until you do.
 */

import { COLLECTION_SLUGS } from "./collection-slugs";
import { ADMIN_LOGIN_PATH } from "@/lib/auth/admin-path";

/**
 * First-level names whose OWN single-segment URL (`/<name>`) is served by a
 * dedicated file route (`page.tsx` / `route.ts`, or a metadata file route) — the
 * dynamic `/[slug]` resolver (and therefore the admin redirect engine) never sees
 * that exact URL. Must match the disk exactly (reserved-routes.test.ts).
 */
export const STATIC_SINGLE_SEGMENT_ROUTES: ReadonlySet<string> = new Set([
  // (shop) — storefront chrome. The content/info + legal pages are NO LONGER
  // file routes: they are editable CMS system pages (Contenu & Design → Pages)
  // served by the `(shop)/(tokyo)/[slug]` resolver (see CMS_SYSTEM_PAGE_SLUGS
  // below, reserved but not file-routes).
  "account",
  "blog",
  "checkout",
  "favoris",
  "forgot-password",
  "login",
  "panier",
  "recherche",
  "register",
  "reset-password",
  "se-desabonner",
  "verify-email",
  // (tokyo) storefront pages added by the in-repo storefront swap — each serves
  // its own single-segment URL via `(shop)/(tokyo)/<name>/page.tsx`. Order
  // tracking stays a functional file route (linked from the header).
  "reels",
  "suivi-de-commande",
  // App root (outside the storefront layout).
  "admin",
  "admin-login",
  "llms.txt",
  "robots.txt",
  // Metadata file routes (sitemap.ts / manifest.ts / icon.svg) + the favicon.
  "sitemap.xml",
  "manifest.webmanifest",
  "icon.svg",
  "favicon.ico",
]);

/**
 * The editable CMS "system pages" (Contenu & Design → Pages) served by the
 * `(shop)/(tokyo)/[slug]` resolver — NOT file routes, but their slugs are
 * reserved so no category / product / custom page can claim them. Seeded on
 * every boot by `ensureSystemContentPages` (instant on deploy).
 */
export const CMS_SYSTEM_PAGE_SLUGS: ReadonlySet<string> = new Set([
  "apropos",
  "recrutement",
  "aide",
  "livraison",
  "garantie",
  "mentions",
  "cgv",
  "cgu",
  "confidentialite",
  "cookies",
]);

/**
 * Static pages that DO consult the admin redirect table for their own URL
 * (`resolveRedirect` at the top of the page) — a rule on them fires.
 */
export const REDIRECT_AWARE_STATIC_ROUTES: ReadonlySet<string> = new Set([
  "blog",
]);

/**
 * Multi-segment URL SHAPES answered before the storefront redirect engine could
 * run (`*` = exactly one segment, a trailing `**` = one or more) — a redirect rule
 * whose source matches one never fires:
 *   - file routes that don't consult the redirect table (order tracking, the
 *     account order detail, auth continuations, CDN / feed / markdown / invoice /
 *     public-profile handlers);
 *   - the next.config legacy 308s (`/category/:slug`, `/category/:slug/:sub`,
 *     `/product/:slug`);
 *   - the whole `/admin/**` (cookie-gated by the proxy — an anonymous visitor is
 *     sent to the staff login — and never a storefront URL) and `/api/**`
 *     (machine surface) trees, plus Next's own `/_next/**` assets.
 * Any OTHER multi-segment path — `/product/<cat>/<slug>` (WooCommerce), a deep
 * `/category/a/b/c`, `/login/x`, `/pro/x`, `/account/x`… — falls through to
 * `/[slug]/[sub]` or the `[...rest]` catch-all, where a rule does fire.
 * reserved-routes.test.ts checks every multi-segment file route outside
 * admin / api that doesn't call resolveRedirect is matched here.
 */
export const APP_ROUTE_SHAPES: ReadonlyArray<string> = [
  "_next/**",
  "account/orders/*",
  "admin/**",
  "api/**",
  "cdn/**",
  "facture/*",
  "feeds/*",
  "login/2fa",
  "md/**",
  "order/*",
  "order/verify/*",
  // /p/[id] — the (tokyo) product short-link (file route, no resolveRedirect).
  "p/*",
  "u/*",
  // /blog/category/[slug] — the legacy nested blog-category URL, now a hard 308 to
  // the flat /blog/<slug> (the file route redirects itself, no resolveRedirect).
  "blog/category/*",
  // next.config legacy 308s:
  "category/*",
  "category/*/*",
  "product/*",
];

/**
 * Every name an entity slug must avoid: the static single-segment routes above,
 * the dynamic-only first-level directories (`/brand/[slug]`, `/order/[id]`,
 * `/u/[slug]`, `/promo/[slug]`, `/cdn/…`, `/feeds/…`, `/md/…`, `/facture/[id]`) —
 * reserved so the rule stays simple (every first-level route directory is
 * reserved) — the legacy redirect surfaces and the vitrine slugs.
 */
export const RESERVED_ROUTES: ReadonlySet<string> = new Set([
  ...STATIC_SINGLE_SEGMENT_ROUTES,
  // Editable CMS system pages served by `(tokyo)/[slug]` (reserved, not file routes):
  ...CMS_SYSTEM_PAGE_SLUGS,
  // Dynamic-only first-level directories:
  "auteur",
  "brand",
  "cdn",
  "facture",
  "feeds",
  "md",
  "order",
  // /p/[id] — the (tokyo) product short-link (dynamic-only, no own single-segment URL).
  "p",
  "promo",
  "u",
  // Legacy redirect surfaces (next.config 308s) — reserve to keep them working:
  "category",
  "product",
  // Smart-collection (Pages vitrine) slugs — derived from the single source so
  // this set can never drift from COLLECTION_SLUGS (a new vitrine page is
  // auto-reserved here).
  ...COLLECTION_SLUGS,
  // Infrastructure paths:
  "api",
  "_next",
]);

/**
 * The first segment of a CUSTOM single-segment `ADMIN_LOGIN_PATH` (e.g.
 * `/staff-x7k2` → `staff-x7k2`): the proxy rewrites that exact URL to the staff
 * login, so an entity slug equal to it would be unreachable. Null for the default
 * `/admin-login` (already reserved) or a multi-segment secret path (its first
 * segment alone still reaches `/[slug]`).
 */
export function adminLoginSlug(adminLoginPath: string = ADMIN_LOGIN_PATH): string | null {
  const segs = adminLoginPath.split("/").filter(Boolean);
  return segs.length === 1 ? segs[0]!.toLowerCase() : null;
}

/** Is `slug` (already trimmed + lower-cased) a reserved first-level route name? */
export function isReservedSlug(slug: string, adminLoginPath: string = ADMIN_LOGIN_PATH): boolean {
  return RESERVED_ROUTES.has(slug) || slug === adminLoginSlug(adminLoginPath);
}
