import type { Category, Product } from "@/storefront/types/catalog";

/**
 * The catalog data contract. Everything the storefront needs to read about
 * products & categories goes through this interface, so the UI is decoupled from
 * *where* the data comes from.
 *
 * The implementation is `liveSource` (see ./live-source) — it reads the backend
 * DB directly (Postgres via `@/lib/api/products`), so every surface reflects
 * admin edits with no re-export. The former bundled-JSON snapshot source has been
 * retired; this seam stays so an alternative transport could be swapped in
 * without touching components or pages.
 */
export interface CatalogSource {
  listAllProducts(): Promise<Product[]>;
  getProductBySlug(slug: string): Promise<Product | null>;
  getProductById(id: string): Promise<Product | null>;
  listProductsByCategory(categorySlug: string, limit?: number): Promise<Product[]>;
  listProductsByIds(ids: string[]): Promise<Product[]>;
  listRelatedProducts(slug: string, limit?: number): Promise<Product[]>;
  listAlsoViewed(slug: string, limit?: number): Promise<Product[]>;
  listNewArrivals(limit?: number): Promise<Product[]>;
  listPromotions(limit?: number): Promise<Product[]>;
  listPreorderProducts(limit?: number): Promise<Product[]>;
  listCategories(): Promise<Category[]>;
  getCategoryBySlug(slug: string): Promise<Category | null>;
  getCategoryLabel(slug: string): Promise<string>;
}
