import type { Category, Product } from "@/storefront/types/catalog";

/**
 * The catalog data contract. Everything the storefront needs to read about
 * products & categories goes through this interface, so the UI is decoupled from
 * *where* the data comes from.
 *
 * Today the only implementation is `staticSource` (bundled JSON). When the
 * Tokyo Store backend is ready, implement `httpSource` against its API and flip
 * `NEXT_PUBLIC_DATA_SOURCE=http` — no component or page changes required.
 */
export interface CatalogSource {
  listAllProducts(): Promise<Product[]>;
  getProductBySlug(slug: string): Promise<Product | null>;
  getProductById(id: string): Promise<Product | null>;
  listProductsByCategory(categorySlug: string): Promise<Product[]>;
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
