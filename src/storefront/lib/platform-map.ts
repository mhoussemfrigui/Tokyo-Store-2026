import type { Product as BackendProduct } from "@/types/catalog";
import { imageUrl } from "@/types/catalog";

import type { Product as UiProduct } from "@/storefront/types/catalog";

/**
 * Map a backend catalogue `Product` (src/types/catalog) onto the storefront UI's
 * flat `Product` DTO (src/storefront/types/catalog), so backend-rendered pages
 * (search, collection) can feed the new UI components. Pure + serialisable — no
 * DB, usable on either side. The backend slug is carried through so every
 * surface (home, category, search, collection, PDP) shares ONE slug space.
 */
export function toUiProduct(p: BackendProduct): UiProduct {
  return {
    id: p.id ?? p.slug,
    slug: p.slug,
    title: p.name,
    link: `/${p.slug}`,
    image: imageUrl(p.image),
    price: p.price,
    currency: "TND",
    availability: p.inStock ? "in_stock" : "out_of_stock",
    condition: p.condition ?? "new",
    brand: p.brand ?? "",
    category: p.category,
    product_type: p.categoryName ?? p.category ?? "",
  };
}
