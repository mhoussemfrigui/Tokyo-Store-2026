import "server-only";

import { categoryService } from "@/modules/catalog/category/service";
import type { CategoryRow } from "@/modules/catalog/category";

/**
 * Category ANCESTOR CHAINS — the single resolver behind every "inherit from the
 * parent" rule on a product's primary category (the TVA category tier and the
 * warranty cascade).
 *
 * The tree allows unlimited nesting (the storefront expects ~4 levels:
 * homme → montres-plongee → submariner …), and both cascades promise "the first
 * value walking from the most-specific category up to the ROOT wins". The call
 * sites used to load only the node + its direct parent, so a rate / warranty set
 * on a grand-parent (or higher) was silently ignored and the line fell through
 * to the global default. Every site now resolves the FULL chain through here so
 * the checkout / panier previews, the order snapshot, the PDP warranty and the
 * admin "hérité" hint can never disagree on which category governs a line.
 *
 * Batched: one `findByIds` per tree LEVEL still missing (O(depth) queries for the
 * whole cart / page, never O(lines)). Callers that already loaded some rows pass
 * them as `seed` so a 2-level tree costs no extra query at all. Cycle-safe (a
 * `seen` set per chain) and depth-capped as a belt-and-braces stop for any
 * pre-existing `parent_id` loop in the data — the same guard philosophy as the
 * update-workflow cycle check.
 */

/** Hard cap on a chain's length (the real tree is ~4 deep). */
export const MAX_CATEGORY_CHAIN_DEPTH = 16;

/**
 * Walk `startId` up through `byId`, returning the chain ordered child → root
 * (index 0 = the category itself). Stops at a root, at an ancestor absent from
 * `byId` (soft-deleted / not loaded), on a cycle, or at `maxDepth`. Pure.
 */
export function buildCategoryChain<T extends { id: string; parent_id: string | null }>(
  startId: string,
  byId: ReadonlyMap<string, T>,
  maxDepth: number = MAX_CATEGORY_CHAIN_DEPTH,
): T[] {
  const chain: T[] = [];
  const seen = new Set<string>();
  let cur = byId.get(startId);
  while (cur && !seen.has(cur.id) && chain.length < maxDepth) {
    chain.push(cur);
    seen.add(cur.id);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return chain;
}

/**
 * Resolve the LIVE ancestor chain (child → root) of every given category id.
 * Ids that don't resolve to a live category map to an empty chain, so callers
 * can read `chains.get(id) ?? []` uniformly. Soft-deleted rows are never
 * returned (`findByIds` filters them), matching the previous node/parent walk.
 */
export async function loadCategoryChains(
  ids: Iterable<string>,
  opts: {
    /** Live rows the caller already loaded (skips re-fetching them). */
    seed?: Iterable<CategoryRow>;
    /** Ids the caller already queried, found OR not — never re-fetched, so a
     *  soft-deleted primary category costs no extra query. */
    lookedUp?: Iterable<string>;
  } = {},
): Promise<Map<string, CategoryRow[]>> {
  const wanted = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  const out = new Map<string, CategoryRow[]>();
  if (wanted.length === 0) return out;

  const byId = new Map<string, CategoryRow>();
  for (const row of opts.seed ?? []) {
    if (row.deleted_at == null) byId.set(row.id, row);
  }
  // Ids already looked up (found OR not) — never re-queried, so a missing /
  // soft-deleted ancestor ends its chain instead of looping.
  const attempted = new Set<string>([...byId.keys(), ...(opts.lookedUp ?? [])]);

  for (let level = 0; level < MAX_CATEGORY_CHAIN_DEPTH; level++) {
    // Collect the next unresolved hop of every wanted chain (one query per level).
    const missing = new Set<string>();
    for (const id of wanted) {
      let cur = byId.get(id);
      if (!cur) {
        if (!attempted.has(id)) missing.add(id);
        continue;
      }
      const seen = new Set<string>();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        const parentId: string | null = cur.parent_id;
        if (!parentId) break;
        const parent = byId.get(parentId);
        if (!parent) {
          if (!attempted.has(parentId)) missing.add(parentId);
          break;
        }
        cur = parent;
      }
    }
    if (missing.size === 0) break;
    const batch = [...missing];
    for (const id of batch) attempted.add(id);
    const rows = await categoryService.findByIds(batch);
    for (const [id, row] of rows) byId.set(id, row);
  }

  for (const id of wanted) out.set(id, buildCategoryChain(id, byId));
  return out;
}
