import "server-only";

import { categoryService } from "@/modules/catalog/category/service";
import type { CareCategoryOpt } from "@/components/admin/care-form";

/**
 * Flatten the live category tree into a depth-ordered list for the Tokyo Care
 * scope checklist. Reads structural columns only (listAllSlim), then walks
 * parent→children in display order so the checklist reads top-down like the
 * catalogue tree. Orphans (parent missing/soft-deleted) are appended at depth 0
 * so they stay selectable.
 */
export async function loadCareCategoryOptions(): Promise<CareCategoryOpt[]> {
  const rows = await categoryService.listAllSlim();
  const byParent = new Map<string | null, typeof rows>();
  for (const r of rows) {
    const key = r.parent_id ?? null;
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(r);
  }
  const known = new Set(rows.map((r) => r.id));
  const out: CareCategoryOpt[] = [];
  const seen = new Set<string>();

  const walk = (parent: string | null, depth: number) => {
    for (const r of byParent.get(parent) ?? []) {
      if (seen.has(r.id)) continue; // guard against cyclic data
      seen.add(r.id);
      out.push({ id: r.id, name: r.name, depth });
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);

  // Append any node whose parent is not a live category (so it isn't dropped).
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    if (r.parent_id && known.has(r.parent_id)) continue;
    out.push({ id: r.id, name: r.name, depth: 0 });
    seen.add(r.id);
  }
  return out;
}
