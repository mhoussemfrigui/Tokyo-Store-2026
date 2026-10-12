import "server-only";

import { inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { product_attribute_assignments } from "@/modules/catalog/attribute/schema";
import { product_brands } from "@/associations/product-brand";
import { brands } from "@/modules/catalog/brand/schema";
import { tax_rules } from "./schema";

export { taxService, type TaxService, type TaxRuleWithLabel } from "./service";

/**
 * Batched filter-tier rate lookup for the place-order / quote path.
 *
 * For each product, finds the MAX `tax_rules.rate_bps` across every attribute
 * value the product carries that has a tax rule. Joining
 * `product_attribute_assignments → tax_rules` on `attribute_value_id` lets us
 * resolve the filter tier for N products in ONE query, then group in SQL via
 * `max(...)`. Products with no matching rule are simply absent from the Map — the
 * caller falls through to the category/global tier in `resolveTaxRateBps`.
 *
 * Returns `Map<productId, bps>`. Empty input → empty Map (no query issued).
 */
export async function taxRuleBpsForProducts(
  productIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (productIds.length === 0) return out;

  const rows = await db
    .select({
      product_id: product_attribute_assignments.product_id,
      max_bps: sql<number>`max(${tax_rules.rate_bps})::int`,
    })
    .from(product_attribute_assignments)
    .innerJoin(
      tax_rules,
      sql`${tax_rules.attribute_value_id} = ${product_attribute_assignments.attribute_value_id}`,
    )
    .where(inArray(product_attribute_assignments.product_id, productIds))
    .groupBy(product_attribute_assignments.product_id);

  for (const r of rows) {
    if (r.max_bps != null) out.set(r.product_id, Number(r.max_bps));
  }
  return out;
}

/**
 * Batched BRAND-tier rate lookup. For each product, its brand's `tax_rate_bps`
 * (via the product_brands join), or absent when the product has no brand or the
 * brand sets no rate — the caller then falls through to the category/global tier.
 * Returns `Map<productId, bps>`. The brand tier sits between filter and category.
 */
export async function brandTaxBpsForProducts(
  productIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (productIds.length === 0) return out;

  // LIVE brands only: a soft-deleted brand keeps its product_brands links (the FK
  // only cascades on a hard delete) but is hidden from the admin tax page, so its
  // rate must stop outranking the category/global tiers — like the category tier,
  // which resolves through the deleted_at-filtered categoryService.findByIds.
  const rows = await db
    .select({ product_id: product_brands.product_id, bps: brands.tax_rate_bps })
    .from(product_brands)
    .innerJoin(brands, sql`${brands.id} = ${product_brands.brand_id} and ${brands.deleted_at} is null`)
    .where(inArray(product_brands.product_id, productIds));

  for (const r of rows) {
    if (r.bps != null) out.set(r.product_id, Number(r.bps));
  }
  return out;
}
