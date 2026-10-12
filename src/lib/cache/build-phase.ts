/**
 * True during `next build` (Next sets `NEXT_PHASE=phase-production-build`).
 *
 * Why it matters: the Docker production build runs with NO database reachable
 * (the DB is a separate service → `ECONNREFUSED`). A plain/`React cache()` DB read
 * that throws during static prerender is CATCHABLE by the caller's `.catch()`, so
 * the page prerenders with a fallback. A `'use cache'` read that throws is instead
 * surfaced as a FATAL prerender error that the caller's `.catch()` can NOT save —
 * it aborts the whole build (`Error occurred prerendering page …`).
 *
 * So a `'use cache'` read reachable from a statically-prerendered page (e.g. the
 * shop layout's nav, rendered for every page) must NOT hit the DB at build. Guard
 * it with this and return a safe fallback during the build phase. This is safe for
 * the storefront because every (shop) page is dynamic at RUNTIME (the layout reads
 * the session cookie), so the build-time fallback is never actually served — the
 * real, cross-request-cached value fills in on the first request.
 */
export function isBuildPhase(): boolean {
  return process.env.NEXT_PHASE === "phase-production-build";
}
