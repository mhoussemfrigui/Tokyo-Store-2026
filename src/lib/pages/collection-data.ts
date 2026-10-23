import "server-only";

import { listShowcaseProducts } from "@/lib/api/products";
import { getTopSellingProducts } from "@/modules/order/queries";
import type { CollectionPageConfig } from "@/lib/pages/collection-page-config";
import type { Product as BackendProduct } from "@/types/catalog";

/**
 * Server-side data for a "Vitrines" / showcase collection page. The SELECTION
 * (which products, in what order) is backend/admin-driven via
 * `listShowcaseProducts` (pins first, then the slug's strategy) — the storefront
 * `[slug]` page then resolves these ids to the bundled snapshot cards the rest
 * of the store renders, so prices/stock stay consistent site-wide.
 *
 * On top of the selection we attach the per-strategy REAL stats the collection
 * design needs and only the backend can provide:
 *   - best_sellers → `salesById`: units sold per product over EACH period window
 *     (so the period selector + "N vendus" + podium read live sales, not a guess);
 *   - new_arrivals → `daysById`: whole days since `published_at` (drives the
 *     "arrivé il y a…" label + the age-window period filter);
 *   - on_promotion → no extra stats (the markdown is read from the card's own
 *     backend compare-at via `productStrike`, like every other listing).
 */
export type CollectionShowcase = {
  /** Backend products in render order (pins first, then the strategy pool), capped to `limit`. */
  products: BackendProduct[];
  /** best_sellers only: product id → units sold in [window0, window1, window2]. */
  salesById: Record<string, [number, number, number]> | null;
  /** new_arrivals only: product id → whole days since publication (null = never stamped). */
  daysById: Record<string, number | null> | null;
  /**
   * on_promotion only: product id → the LIVE effective price + compare-at (dinars),
   * as enriched by `listShowcaseProducts` (engine promos + stored markdowns). The
   * promotions page is *about* the discount, so its cards read this live pricing
   * rather than the bundled snapshot's (which can lag an engine-only promo).
   */
  promoById: Record<string, { price: number; oldPrice: number | null }> | null;
};

export async function getCollectionShowcase(
  config: CollectionPageConfig,
  /** The period day-windows from the collection copy (best_sellers needs all three). */
  windows: number[],
): Promise<CollectionShowcase> {
  const products = await listShowcaseProducts(config);

  if (config.strategy === "best_sellers") {
    const w = windows.length === 3 ? windows : [7, 30, 365];
    // One top-sellers aggregate per window — cap generously so every showcased
    // card is covered even if it ranks deep in the longest window.
    const cap = Math.max(300, config.limit * 3);
    const [a, b, c] = await Promise.all(w.map((d) => getTopSellingProducts(cap, d).catch(() => [])));
    const asMap = (rows: Awaited<ReturnType<typeof getTopSellingProducts>>) =>
      new Map(rows.map((r) => [r.productId, r.quantity]));
    const [ma, mb, mc] = [asMap(a), asMap(b), asMap(c)];
    const salesById: Record<string, [number, number, number]> = {};
    for (const p of products) {
      if (!p.id) continue;
      salesById[p.id] = [ma.get(p.id) ?? 0, mb.get(p.id) ?? 0, mc.get(p.id) ?? 0];
    }
    return { products, salesById, daysById: null, promoById: null };
  }

  if (config.strategy === "new_arrivals") {
    const now = Date.now();
    const daysById: Record<string, number | null> = {};
    for (const p of products) {
      if (!p.id) continue;
      daysById[p.id] = p.publishedAt
        ? Math.max(0, Math.floor((now - new Date(p.publishedAt).getTime()) / 86_400_000))
        : null;
    }
    return { products, salesById: null, daysById, promoById: null };
  }

  if (config.strategy === "preorder") {
    // Plain selection — the card already renders the "Précommande" badge + release
    // note from each product's availability/preorderReleasesAt (no extra stats).
    return { products, salesById: null, daysById: null, promoById: null };
  }

  // on_promotion — carry the live effective price + compare-at per product.
  const promoById: Record<string, { price: number; oldPrice: number | null }> = {};
  for (const p of products) {
    if (!p.id) continue;
    promoById[p.id] = { price: p.price, oldPrice: p.oldPrice ?? null };
  }
  return { products, salesById: null, daysById: null, promoById };
}
