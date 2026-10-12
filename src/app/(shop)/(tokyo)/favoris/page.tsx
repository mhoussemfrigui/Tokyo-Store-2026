import type { Metadata } from "next";

import { readWishlistSlugs } from "@/lib/wishlist/session";
import { FavoritesView } from "@/storefront/components/storefront/favorites-view";
import { listNewArrivals, listRelatedProducts } from "@/storefront/lib/api/products";

export const metadata: Metadata = {
  title: "Mes favoris",
  description: "Retrouvez tous les produits Tokyo Store que vous avez ajoutés à vos favoris.",
  robots: { index: false, follow: true },
};

/**
 * Personal favourites page. The live list is driven client-side by the backend
 * wishlist store (`useFavorites`), but the "Vous aimerez aussi" rail is read
 * server-side here from the REAL catalog so it paints with SSR: seed on the
 * viewer's first favourite (related products), else fall back to new arrivals,
 * then drop anything already favourited. Read-only (`readWishlistSlugs` writes
 * no cookie), so it is safe in this RSC render.
 */
export default async function FavoritesPage() {
  const favSlugs = await readWishlistSlugs();
  const seed = favSlugs[0];
  const pool = seed ? await listRelatedProducts(seed, 10) : await listNewArrivals(10);
  const recommendations = pool.filter((p) => !favSlugs.includes(p.slug)).slice(0, 8);

  return <FavoritesView recommendations={recommendations} />;
}
