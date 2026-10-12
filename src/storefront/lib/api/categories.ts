import "server-only";

import { catalogSource } from "@/storefront/lib/data";

/**
 * Server-only category facade — see `@/storefront/lib/api/products` for the rationale.
 */
export const listCategories = () => catalogSource.listCategories();
export const getCategoryBySlug = (slug: string) => catalogSource.getCategoryBySlug(slug);
export const getCategoryLabel = (slug: string) => catalogSource.getCategoryLabel(slug);
