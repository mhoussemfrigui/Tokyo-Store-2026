import "server-only";

import { careService } from "@/modules/catalog/care/service";
import { categoryService } from "@/modules/catalog/category/service";
import { resolveOfferedCarePlans, type CareProductCtx, type OfferedCarePlan } from "./charge";
import { scopeOfferedFromTargets } from "./scope";

/**
 * Per-line input for the batched Tokyo Care resolver. `productPriceCents` is the
 * line's EFFECTIVE unit price (percent plans apply to it); `categoryIds` the
 * product's live category ids (for the scope match).
 */
export type CareResolveLine = CareProductCtx & { productId: string; categoryIds: string[] };

/**
 * Resolve the Tokyo Care plans OFFERED on each input line, with per-unit prices —
 * one batched set of reads (active plans, category scope targets, the category
 * tree, and the product-care overrides for exactly these products) feeding the
 * pure {@link resolveOfferedCarePlans} per line. Returns an array ALIGNED to
 * `lines` (same index), each the offered plans for that line (empty if none).
 *
 * This is the single resolver behind BOTH the storefront offer (PDP / cart) and
 * the authoritative order charge, so the price a shopper sees is the price the
 * server charges.
 */
export async function resolveOfferedCareForLines(
  lines: CareResolveLine[],
): Promise<OfferedCarePlan[][]> {
  if (lines.length === 0) return [];
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const [activePlans, targets, cats, careByProduct] = await Promise.all([
    careService.list({ activeOnly: true }),
    careService.getAllCategoryScopeTargets(),
    categoryService.listAllSlim(),
    careService.getProductCareForProducts(productIds),
  ]);
  const parent = new Map(cats.map((c) => [c.id, c.parent_id ?? null]));

  return lines.map((l) => {
    const scopeSet = scopeOfferedFromTargets(l.categoryIds, parent, targets);
    return resolveOfferedCarePlans(
      { productPriceCents: l.productPriceCents, warrantyMonths: l.warrantyMonths, condition: l.condition },
      activePlans,
      scopeSet,
      careByProduct.get(l.productId) ?? [],
    );
  });
}
