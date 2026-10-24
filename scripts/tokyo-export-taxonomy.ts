/**
 * Export the backend's category hierarchy into the storefront's nav taxonomy
 * snapshot (`src/storefront/data/taxonomy.json`), consumed by
 * `@/storefront/lib/categoryNav` for breadcrumb trails + universe crumbs.
 *
 * The product CATALOGUE itself is NO LONGER exported — the storefront reads it
 * LIVE from Postgres (catalogSource → `@/lib/api/products`), so prices, stock,
 * categories and Tokyo Care reflect admin edits with no re-export. This script
 * only regenerates the small, stable nav tree: category names + rolled-up
 * product counts (a category + all its descendants), empty branches pruned.
 * Re-run after taxonomy changes (new categories, re-parenting):
 *
 *   pnpm tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     scripts/tokyo-export-taxonomy.ts
 */
import fs from "node:fs";
import path from "node:path";

import { listApiProducts } from "@/lib/api/products";
import { categoryService } from "@/modules/catalog/category/service";

const OUT_DIR = path.join(process.cwd(), "src/storefront/data");

/** A node of the nav taxonomy tree emitted to taxonomy.json. */
type TaxoNode = {
  slug: string;
  name: string;
  /** Rolled-up product count (this category + every descendant). */
  count: number;
  children: TaxoNode[];
};

async function main(): Promise<void> {
  // Category tree → each slug's ancestor chain (root→leaf), so a product filed on
  // a leaf rolls its count up to every ancestor.
  const cats = await categoryService.listAll();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const bySlug = new Map(cats.map((c) => [c.slug, c]));
  const chainSlugs = (slug: string): string[] => {
    const start = bySlug.get(slug);
    if (!start) return [];
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: (typeof cats)[number] | undefined = start;
    while (cur && !seen.has(cur.id)) {
      chain.unshift(cur.slug);
      seen.add(cur.id);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return chain;
  };

  // Page the full published catalogue to accumulate rolled-up counts per slug.
  // File each product at its DEEPEST category (subcategory ?? category), then add
  // 1 to that leaf AND every ancestor (de-duped per product).
  const rollup = new Map<string, number>();
  const LIMIT = 100;
  for (let offset = 0; offset < 100000; ) {
    const page = await listApiProducts({ limit: LIMIT, offset, public: false });
    if (page.length === 0) break;
    for (const p of page) {
      const leaf = p.subcategory ?? p.category;
      for (const s of new Set(chainSlugs(leaf))) rollup.set(s, (rollup.get(s) ?? 0) + 1);
    }
    offset += page.length;
  }

  // Build the tree (roots → children), pruning empty branches at every level so
  // the nav never links to a shelf with no products. Biggest universe first.
  const childrenByParent = new Map<string | null, (typeof cats)[number][]>();
  for (const c of cats) {
    const key = c.parent_id ?? null;
    (childrenByParent.get(key) ?? childrenByParent.set(key, []).get(key)!).push(c);
  }
  const buildNode = (c: (typeof cats)[number]): TaxoNode => ({
    slug: c.slug,
    name: c.name,
    count: rollup.get(c.slug) ?? 0,
    children: (childrenByParent.get(c.id) ?? [])
      .map(buildNode)
      .filter((n) => n.count > 0)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  });
  const taxonomy = (childrenByParent.get(null) ?? [])
    .map(buildNode)
    .filter((n) => n.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  fs.writeFileSync(path.join(OUT_DIR, "taxonomy.json"), JSON.stringify(taxonomy, null, 2));
  console.log(`[export] wrote ${taxonomy.length} nav universes to ${OUT_DIR}/taxonomy.json`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
