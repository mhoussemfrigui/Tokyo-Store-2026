import "server-only";

import { catalogSource } from "@/storefront/lib/data";

/**
 * Server-only product facade. Storefront server components import from here
 * (never the data source directly), mirroring the main platform's `@/storefront/lib/api/*`
 * layer. Swapping the underlying source (static → backend) is invisible here.
 */
export const listAllProducts = () => catalogSource.listAllProducts();
export const getProductBySlug = (slug: string) => catalogSource.getProductBySlug(slug);
export const getProductById = (id: string) => catalogSource.getProductById(id);
export const listProductsByCategory = (categorySlug: string) =>
  catalogSource.listProductsByCategory(categorySlug);
export const listProductsByIds = (ids: string[]) => catalogSource.listProductsByIds(ids);
export const listRelatedProducts = (slug: string, limit?: number) =>
  catalogSource.listRelatedProducts(slug, limit);
export const listAlsoViewed = (slug: string, limit?: number) =>
  catalogSource.listAlsoViewed(slug, limit);
export const listNewArrivals = (limit?: number) => catalogSource.listNewArrivals(limit);
export const listPromotions = (limit?: number) => catalogSource.listPromotions(limit);
export const listPreorderProducts = (limit?: number) => catalogSource.listPreorderProducts(limit);
