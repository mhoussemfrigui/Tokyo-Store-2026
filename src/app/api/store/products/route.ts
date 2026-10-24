import { NextResponse } from "next/server";

import { catalogSource } from "@/storefront/lib/data";
import { checkRateLimit } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/client-ip";
import { requireFirstParty } from "@/lib/api-auth/same-origin";
import { isSiteGatedForViewer } from "@/lib/site-mode/config";
import type { Product } from "@/storefront/types/catalog";

/**
 * First-party storefront product reader for CLIENT surfaces (favorites, cart line
 * resolution, home product shelves) that used to read the bundled products.json snapshot.
 * Returns LIVE catalogue cards (catalogSource → Postgres), so those surfaces reflect admin
 * edits with no re-export.
 *
 *   GET /api/store/products?slugs=a,b,c     — resolve specific products by slug (order kept)
 *   GET /api/store/products?category=slug   — products in a category (rolled up to descendants)
 *
 * First-party only (the storefront's own pages); external consumers use the key-gated
 * /api surface. Edge-cached briefly so a shelf render / cart open doesn't hammer Postgres.
 */
const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=10, s-maxage=30, stale-while-revalidate=60",
} as const;

const MAX_SLUGS = 60;

export async function GET(request: Request) {
  const notFirstParty = requireFirstParty(request);
  if (notFirstParty) return notFirstParty;

  // Closed store (maintenance / coming-soon): return nothing, never CDN-cached.
  if (await isSiteGatedForViewer()) {
    return NextResponse.json({ products: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const ip = getClientIp(request.headers) || "anon";
  const rl = await checkRateLimit({ bucket: `store-products:ip:${ip}`, max: 120, windowSeconds: 60 });
  if (!rl.ok) {
    return NextResponse.json(
      { products: [], error: "rate_limited" },
      { status: 429, headers: { "Cache-Control": "no-store" } },
    );
  }

  const url = new URL(request.url);
  const slugsParam = (url.searchParams.get("slugs") ?? "").trim();
  const category = (url.searchParams.get("category") ?? "").trim();
  // Optional per-category cap for CLIENT shelves/rails that render a handful of
  // cards (home universe tabs, accessory rail). Without it a root universe like
  // "univers-apple" rolls up to ~900 products (~0.8 MB) just to show ~12 — a
  // regression the snapshot's synchronous filter never had. Clamped 1..200; a
  // bare `?category=` with no limit still returns the full tree (the category
  // PAGE needs every product for faceted filtering, but it reads the source
  // server-side, not through this route).
  const limitParam = url.searchParams.get("limit");
  const parsedLimit = limitParam != null ? Number.parseInt(limitParam, 10) : NaN;
  const categoryLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(parsedLimit, 200))
    : undefined;

  try {
    let products: Product[] = [];
    if (slugsParam) {
      const slugs = slugsParam
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, MAX_SLUGS);
      const resolved = await Promise.all(slugs.map((s) => catalogSource.getProductBySlug(s).catch(() => null)));
      // Preserve the requested order; drop slugs that no longer resolve.
      products = resolved.filter((p): p is Product => Boolean(p));
    } else if (category) {
      // One or more category slugs (comma-separated) — union, de-duped by id, order
      // preserved. A single slug rolls up to its descendants (listProductsByCategory).
      const slugs = category
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 40);
      const lists = await Promise.all(
        slugs.map((s) => catalogSource.listProductsByCategory(s, categoryLimit).catch(() => [] as Product[])),
      );
      const seen = new Set<string>();
      for (const list of lists) {
        for (const p of list) {
          if (!seen.has(p.id)) {
            seen.add(p.id);
            products.push(p);
          }
        }
      }
      // Cap the de-duped union too, so several small categories can't sum past
      // the shelf's need (the per-category limit bounds each list individually).
      if (categoryLimit && products.length > categoryLimit) {
        products = products.slice(0, categoryLimit);
      }
    }
    return NextResponse.json({ products }, { headers: CACHE_HEADERS });
  } catch (err) {
    // Never let a storefront shelf / cart 500: return empty, don't cache the failure.
    console.error("[api/store/products] failure", { slugsParam, category, err });
    return NextResponse.json(
      { products: [], error: "unavailable" },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
