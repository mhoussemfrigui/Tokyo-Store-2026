import {
  categories,
  findCategory,
  findProductById,
  findProductBySlug,
  getCategoryLabel,
  getProductsForSlug,
  products,
} from "@/storefront/lib/catalog";
import { alsoViewed, relatedProducts } from "@/storefront/lib/productMeta";
import type { CatalogSource } from "./source";

/**
 * Static catalog source — reads the bundled JSON in `src/data`. Async signatures
 * mirror the future HTTP source so pages can `await` uniformly.
 */
export const staticSource: CatalogSource = {
  async listAllProducts() {
    return products;
  },
  async getProductBySlug(slug) {
    return findProductBySlug(slug) ?? null;
  },
  async getProductById(id) {
    return findProductById(id) ?? null;
  },
  async listProductsByCategory(categorySlug) {
    return getProductsForSlug(categorySlug);
  },
  async listProductsByIds(ids) {
    return ids.flatMap((id) => {
      const p = findProductById(id);
      return p ? [p] : [];
    });
  },
  async listRelatedProducts(slug, limit = 8) {
    const p = findProductBySlug(slug);
    return p ? relatedProducts(p, limit) : [];
  },
  async listAlsoViewed(slug, limit = 8) {
    const p = findProductBySlug(slug);
    return p ? alsoViewed(p, limit) : [];
  },
  async listNewArrivals(limit = 12) {
    return products.slice(0, limit);
  },
  async listCategories() {
    return categories;
  },
  async getCategoryBySlug(slug) {
    return findCategory(slug) ?? null;
  },
  async getCategoryLabel(slug) {
    return getCategoryLabel(slug);
  },
};
