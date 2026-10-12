import "server-only";

import { buildCategoryChain, loadCategoryChains } from "@/lib/catalog/category-chain";
import { categoryService } from "./service";
import type { CategoryRow, CategorySlimRow } from "./schema";

// The tree is built from the STRUCTURAL projection (listAllSlim) — the builders
// and every consumer read only structure (id/slug/name/parent/order/active/icon/
// noindex/…), never the heavy description / editorial / value_props / meta text.
export type CategoryTreeNode = CategorySlimRow & {
  children: CategoryTreeNode[];
};

/**
 * STOREFRONT VISIBILITY RULE — a category is public only when it AND every
 * ancestor are active. Deactivating a parent hides its whole subtree: the mega
 * menu (`listCategories`) already drops an inactive root with its children, so
 * the flat `/[slug]` resolver, the `/[parent]/[sub]` route and the sitemap must
 * agree, or an active child of a deactivated parent stays reachable + indexed
 * with a breadcrumb linking to the parent's 404.
 *
 * `chain` is a `buildCategoryChain` result (child → root). A missing / soft-
 * deleted ancestor ends the chain (the orphan-as-root rule `getCategoryTree`
 * applies), so only LIVE ancestors are judged. Pure.
 */
export function isCategoryChainActive(chain: readonly Pick<CategoryRow, "is_active">[]): boolean {
  return chain.length > 0 && chain.every((c) => c.is_active);
}

/**
 * Leading run of a root → leaf trail up to (excluding) its first INACTIVE node.
 * Everything from that node down 404s on the storefront (see
 * `isCategoryChainActive`), so a breadcrumb must never link past it. Pure.
 */
export function cutTrailAtInactive<T extends Pick<CategoryRow, "is_active">>(
  trail: readonly T[],
): T[] {
  const firstInactive = trail.findIndex((c) => !c.is_active);
  return firstInactive === -1 ? [...trail] : trail.slice(0, firstInactive);
}

/**
 * Storefront breadcrumb trail (root → … → the category itself) for a category
 * id, cut at the first inactive node so no crumb / BreadcrumbList item links to
 * a 404. `null` when the id doesn't resolve to a live category (caller falls
 * back); `[]` when even the root is deactivated. O(depth) batched queries.
 */
export async function getStorefrontCategoryTrail(categoryId: string): Promise<CategoryRow[] | null> {
  const chain = (await loadCategoryChains([categoryId])).get(categoryId) ?? [];
  if (chain.length === 0) return null;
  return cutTrailAtInactive([...chain].reverse());
}

/**
 * Flat list of every STOREFRONT-VISIBLE category (roots AND sub-categories at
 * all depths) for the sitemap — slug + noindex + real `updated_at` lastmod.
 * Unlike `listCategories` (API tree, roots only) this surfaces sub-categories
 * too, so the sitemap can emit their canonical flat `/[slug]` URLs. Visible =
 * the row AND its whole live ancestor chain active (`isCategoryChainActive`) —
 * an active child of a deactivated parent 404s, so it must not be listed. One
 * SELECT; the chains are walked in memory. The caller pairs the ids with
 * `countProductsForCategoryTrees` to drop empty categories.
 */
export async function listSitemapCategories(): Promise<
  Array<{
    id: string;
    slug: string;
    noindex: boolean;
    canonical_url: string | null;
    updatedAt: Date;
  }>
> {
  const all = await categoryService.listAllSlim();
  const byId = new Map(all.map((c) => [c.id, c]));
  return all
    .filter((c) => isCategoryChainActive(buildCategoryChain(c.id, byId)))
    .map((c) => ({
      id: c.id,
      slug: c.slug,
      noindex: c.noindex,
      // Surfaced so the sitemap can drop a category whose canonical override
      // folds it onto another URL (mirrors the products/brands guard) — else
      // Search Console flags "Submitted URL not selected as canonical".
      canonical_url: c.canonical_url,
      updatedAt: c.updated_at,
    }));
}

/**
 * Returns the category tree (roots → children).
 * Single SELECT, in-memory grouping — cheap for the typical ~50 categories.
 *
 * Orphan-safe: a node whose `parent_id` points at a row that is NOT in the live
 * set (soft-deleted, hard-deleted, or a corrupt dangling id) is surfaced as a
 * ROOT instead of silently vanishing. `deleteCategoryWorkflow` now promotes live
 * children one level up so this should rarely fire — but it guarantees no live
 * category can ever drop out of the admin tree (and every parent-picker built
 * from it) just because its ancestor went away.
 */
export async function getCategoryTree(): Promise<CategoryTreeNode[]> {
  const all = await categoryService.listAllSlim();
  const liveIds = new Set(all.map((c) => c.id));
  const byParent = new Map<string | null, CategorySlimRow[]>();
  for (const c of all) {
    // Treat a parent_id that doesn't resolve to a live row as a root.
    const key = c.parent_id && liveIds.has(c.parent_id) ? c.parent_id : null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }
  // Guard against a parent_id cycle in corrupt data: never revisit a node, so a
  // loop terminates instead of recursing forever.
  const seen = new Set<string>();
  const build = (parentId: string | null): CategoryTreeNode[] =>
    (byParent.get(parentId) ?? [])
      .filter((c) => !seen.has(c.id))
      .map((c) => {
        seen.add(c.id);
        return { ...c, children: build(c.id) };
      });
  const roots = build(null);
  // A PURE cycle (e.g. A.parent=B, B.parent=A, both live) buckets each node under
  // the other — neither lands under `null`, so build() never reaches them and
  // they'd vanish. Surface any still-unseen live node as a flat root so NO live
  // category can ever drop out (corrupt data only; all write paths reject cycles).
  for (const c of all) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      roots.push({ ...c, children: [] });
    }
  }
  return roots;
}

/**
 * Storefront category-by-slug resolver. Restricted to STOREFRONT-VISIBLE
 * categories — the row AND every ancestor active (`isCategoryChainActive`) — so
 * a deactivated category, and every descendant under it, 404s at /[slug]
 * (mirroring how an inactive brand is treated). The admin tree reads via
 * `getCategoryTree`, which is unaffected and still surfaces inactive categories.
 * A root costs no extra query; a nested node walks its ancestors (O(depth)).
 *
 * Resolves ANY depth (parentId undefined = search anywhere): slugs are
 * globally unique on the flat /[slug] namespace, and with the 4-level
 * tokyostore.tn tree every node (homme, montres-plongee, submariner…) is a real
 * page. Products attach to their whole ancestor chain, so parent pages
 * aggregate their descendants' products.
 */
export async function getCategoryBySlug(slug: string): Promise<CategoryRow | null> {
  const node = await categoryService.findBySlug(slug, undefined, { activeOnly: true });
  if (!node?.parent_id) return node;
  const chain = (await loadCategoryChains([node.id], { seed: [node] })).get(node.id) ?? [];
  return isCategoryChainActive(chain) ? node : null;
}

export async function getSubcategoryBySlug(
  parentSlug: string,
  subSlug: string,
): Promise<CategoryRow | null> {
  // Parent may itself sit anywhere in the tree (any depth).
  const parent = await categoryService.findBySlug(parentSlug);
  if (!parent) return null;
  return categoryService.findBySlug(subSlug, parent.id);
}

/**
 * The NESTED descendant subtree rooted under `rootId` (its children → grand-
 * children → …), each node carrying its own `children`. Same one-SELECT +
 * in-memory grouping as {@link getCategoryTree}, but returning only the branch
 * beneath one node. The storefront category page needs the FULL nested tree
 * (not just direct children) so the in-place "Catégorie" facet can prune to the
 * branches that actually hold products on a root/hub page ≥2 levels above the
 * leaves where products are filed. Orphan/cycle-safe (a seen-set stops loops).
 */
export async function getCategorySubtreeChildren(rootId: string): Promise<CategoryTreeNode[]> {
  const all = await categoryService.listAllSlim();
  const byParent = new Map<string, CategorySlimRow[]>();
  for (const c of all) {
    if (!c.parent_id) continue;
    if (!byParent.has(c.parent_id)) byParent.set(c.parent_id, []);
    byParent.get(c.parent_id)!.push(c);
  }
  const seen = new Set<string>();
  const build = (parentId: string): CategoryTreeNode[] =>
    (byParent.get(parentId) ?? [])
      .filter((c) => !seen.has(c.id))
      .map((c) => {
        seen.add(c.id);
        return { ...c, children: build(c.id) };
      });
  return build(rootId);
}
