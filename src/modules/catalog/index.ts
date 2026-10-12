/**
 * Catalog parent barrel.
 *
 * The catalog domain spans five sub-modules — attribute, brand, category,
 * product, review — each independently shaped per the canonical pattern in
 * `docs/modules.md`. This file re-exports the brand/category/product
 * surfaces under one import path so higher layers can write:
 *
 *   import { brandQueries, categoryQueries, productQueries } from "@/modules/catalog";
 *
 * Sub-modules can also be imported directly when only one of them is needed
 * (attribute and review are ONLY reachable that way):
 *
 *   import { brandQueries } from "@/modules/catalog/brand";
 *
 * Both work; pick whichever keeps the importing file's intent clearest.
 *
 * Sub-module services (`brandService`, `productService`, `categoryService`)
 * are deliberately NOT re-exported here — services stay internal per the
 * "workflows orchestrate; services hide" rule. Workflows reach into each
 * sub-module directly via its own `./service` path.
 */

export * from "./brand";
export * from "./category";
export * from "./product";
