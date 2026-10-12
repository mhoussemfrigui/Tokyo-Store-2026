import type { Category, Product } from "@/storefront/types/catalog";
import { minorToDinars } from "@/storefront/lib/price";
import type { CatalogSource } from "./source";

/**
 * HTTP catalog source — the future backend adapter (NOT wired up yet).
 *
 * When the Tokyo Store backend is ready, implement each method against its API
 * and map the backend `ApiProduct` → this app's `Product` DTO here, so the rest
 * of the app never changes. Sketch of the mapping (see `src/types/catalog.ts`):
 *
 *   function toProduct(api): Product {
 *     return {
 *       id: api.id,
 *       slug: api.slug,
 *       title: api.name,
 *       image: api.image,
 *       link: `/${api.slug}`,
 *       price: minorToDinars(api.priceCents),
 *       currency: api.currency ?? "TND",
 *       availability: api.inStock ? "in_stock" : "out_of_stock",
 *       condition: api.condition ?? "new",
 *       brand: api.brand ?? "",
 *       category: api.categorySlug,
 *       product_type: api.categoryPath ?? "",
 *     };
 *   }
 *
 * Then swap the source with `NEXT_PUBLIC_DATA_SOURCE=http` +
 * `NEXT_PUBLIC_API_URL=https://api.tokyostore.tn`.
 */
export function createHttpSource(baseUrl: string): CatalogSource {
  // Referenced so the mapping helper above stays type-checked and imported.
  void minorToDinars;
  void baseUrl;

  const notImplemented = (): never => {
    throw new Error(
      "HTTP catalog source is not implemented yet. Implement src/lib/data/http-source.ts " +
        "against the Tokyo Store backend, mapping ApiProduct → Product (see the file header), " +
        "then set NEXT_PUBLIC_DATA_SOURCE=http and NEXT_PUBLIC_API_URL.",
    );
  };

  return {
    listAllProducts: (): Promise<Product[]> => notImplemented(),
    getProductBySlug: (): Promise<Product | null> => notImplemented(),
    getProductById: (): Promise<Product | null> => notImplemented(),
    listProductsByCategory: (): Promise<Product[]> => notImplemented(),
    listProductsByIds: (): Promise<Product[]> => notImplemented(),
    listRelatedProducts: (): Promise<Product[]> => notImplemented(),
    listAlsoViewed: (): Promise<Product[]> => notImplemented(),
    listNewArrivals: (): Promise<Product[]> => notImplemented(),
    listCategories: (): Promise<Category[]> => notImplemented(),
    getCategoryBySlug: (): Promise<Category | null> => notImplemented(),
    getCategoryLabel: (): Promise<string> => notImplemented(),
  };
}
