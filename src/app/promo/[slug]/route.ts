import { NextResponse, type NextRequest } from "next/server";

import { promotionService } from "@/modules/promotion";
import { resolveRedirect } from "@/lib/redirects/resolve";

/**
 * `GET /promo/<slug>` — shareable promo URL (announcement-email CTA, shared
 * links). A ROUTE HANDLER, not a page: setting a cookie is only allowed in a
 * Route Handler / Server Action — a Server Component page throws
 * `ReadonlyRequestCookiesError` on `cookies().set`, which broke every valid link.
 *
 * Visiting this URL:
 *   1. Honors an admin redirect for this path first (Redirections & 404).
 *   2. Looks up a LIVE `url`-trigger promotion matching the slug.
 *   3. On a hit, drops an httpOnly cookie (`gz.promo`) carrying the promotion
 *      id. The value is only a lookup key — cart, checkout and quick-buy
 *      re-validate the live promotion row (window, caps, targeting) when
 *      computing totals, so a forged or stale cookie never grants a discount.
 *   4. Redirects to `/` (307) for every scope today. Scope-aware landing (a
 *      product-scoped promo jumping to `/<product-slug>`) is follow-up work.
 *
 * On a miss (unknown slug, expired window, deactivated): redirect to `/`
 * silently, WITHOUT a cookie. Shouting "promo not found" surfaces unintended
 * ops detail to shoppers and creates a phishing surface.
 *
 * Lives outside the `(shop)` group on purpose: a route handler renders no
 * layout, and this keeps its catalogued path (route-catalog) the real URL.
 */
export const dynamic = "force-dynamic";

/** Read by `lib/cart/coupon.ts` (PROMO_URL_COOKIE) + the quick-buy fallback in
 *  `lib/actions/order.ts` — keep the three in sync. */
const COOKIE_NAME = "gz.promo";
const COOKIE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days — beyond which the
// promotion has typically ended anyway. The cart layer re-checks the
// promotion's live window on every read, so a stale cookie never grants
// an expired discount.

/** Same shape the admin form enforces for a URL slug (workflows/promotion). */
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;
  // Honor an admin redirect for this promo URL before the promo lookup.
  // (`redirect()` / `permanentRedirect()` are supported in route handlers.)
  await resolveRedirect(`/promo/${slug}`);

  const promo =
    slug.length <= 80 && SLUG_RE.test(slug)
      ? await promotionService.findLiveByUrlSlug(slug).catch(() => null)
      : null;

  // RELATIVE Location: the browser resolves it against the public origin (a
  // proxied container's request URL can carry the internal host). no-store so
  // a CDN never caches a Set-Cookie redirect.
  const res = new NextResponse(null, {
    status: 307,
    headers: { Location: "/", "Cache-Control": "no-store" },
  });
  if (promo) {
    res.cookies.set(COOKIE_NAME, promo.id, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: COOKIE_TTL_SECONDS,
    });
  }
  return res;
}
