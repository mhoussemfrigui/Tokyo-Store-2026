import "server-only";

import { careService } from "@/modules/catalog/care/service";
import { categoryService } from "@/modules/catalog/category/service";
import type { CarePlanScopeTargetRow } from "@/modules/catalog/care/schema";

/**
 * PURE: given a product's category ids, the live category parent map, and the
 * active CATEGORY scope targets, return the plan ids whose scope covers the
 * product. A target matches a product category X when:
 *   - include_descendants: target_id is X or any ANCESTOR of X (a plan scoped to a
 *     parent category covers the whole subtree), or
 *   - not include_descendants: target_id is exactly X.
 * No DB — the caller batches the two reads once and calls this per product.
 */
export function scopeOfferedFromTargets(
  categoryIds: string[],
  parent: Map<string, string | null>,
  targets: CarePlanScopeTargetRow[],
): Set<string> {
  const offered = new Set<string>();
  if (categoryIds.length === 0 || targets.length === 0) return offered;

  const direct = new Set(categoryIds);
  const ancestorInclusive = new Set(direct);
  for (const id of categoryIds) {
    let cur = parent.get(id) ?? null;
    let guard = 0;
    while (cur && guard++ < 100) {
      if (ancestorInclusive.has(cur)) break;
      ancestorInclusive.add(cur);
      cur = parent.get(cur) ?? null;
    }
  }
  for (const t of targets) {
    const matches = t.include_descendants ? ancestorInclusive.has(t.target_id) : direct.has(t.target_id);
    if (matches) offered.add(t.care_plan_id);
  }
  return offered;
}

/**
 * Resolve which Tokyo Care plans a product is offered from its CATEGORY scope
 * alone (the "Auto" outcome — product-level overrides apply on top by the caller).
 * Loads the active category scope targets + the live category tree, then defers to
 * {@link scopeOfferedFromTargets}. Both reads are cache-deduped per request.
 */
export async function scopeOfferedPlanIdsForCategories(categoryIds: string[]): Promise<string[]> {
  if (categoryIds.length === 0) return [];
  const [targets, cats] = await Promise.all([
    careService.getAllCategoryScopeTargets(),
    categoryService.listAllSlim(),
  ]);
  if (targets.length === 0) return [];
  const parent = new Map(cats.map((c) => [c.id, c.parent_id ?? null]));
  return [...scopeOfferedFromTargets(categoryIds, parent, targets)];
}
