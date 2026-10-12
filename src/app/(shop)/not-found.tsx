import { NotFoundScene } from "@/components/not-found-scene";
import { getNotFoundConfig } from "@/lib/redirects/config";

// Render per-request so admin 404 copy edits (notfound.*) apply here too.
export const dynamic = "force-dynamic";

/**
 * Storefront 404 boundary.
 *
 * ⚠ WHY THIS FILE EXISTS (and why it sits at the `(shop)` root, not in `(shell)`):
 * a matched `[slug]` that calls `notFound()` falls back to the nearest not-found
 * boundary. With ONLY the root `app/not-found.tsx`, Next renders it chrome-free on
 * the server but the CLIENT keeps the matched route's group layout mounted around
 * it — so the header/footer reappear after hydration (the exact bug we chased).
 *
 * Putting the boundary HERE fixes it: a not-found boundary renders inside its own
 * layout chain (the thin `(shop)/layout.tsx` — no chrome) and DISCARDS every layout
 * below it, including `(shell)/layout.tsx`'s header/footer. Result: a storefront 404
 * is chrome-free on server AND client, matching `/admin`.
 *
 * Identical body to `app/not-found.tsx` — the same single source of truth for copy.
 */
export default async function ShopNotFound() {
  // getNotFoundConfig is internally defensive (returns NOT_FOUND_DEFAULTS on any
  // failure), so it's the single source of truth — no inline fallback strings.
  const cfg = await getNotFoundConfig();
  return (
    <NotFoundScene
      title={cfg.title}
      message={cfg.message}
      showSearch={cfg.showSearch}
      showSuggestions={cfg.showSuggestions}
      logoUrl={cfg.logoUrl}
    />
  );
}
