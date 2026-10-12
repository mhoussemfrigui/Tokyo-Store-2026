/**
 * Catalog seed — mirrors the live tokyostore.tn taxonomy the shop is
 * migrating from (see src/lib/db/catalog-tree.ts for the full tree).
 *
 *   pnpm db:seed:catalog
 *
 * Inserts the recursive catalog tree (Homme, Femme, Enfants + an
 * Accessoires root one level deep — Accessoires → Bracelets…) plus the
 * starter brand list.
 *
 * URLs are flat — every entity sits on `/[slug]`, so slugs are GLOBALLY
 * unique and self-descriptive (`/homme`, `/accessoires`, `/bracelets`).
 *
 * Idempotent: re-running skips rows that already exist (matched by slug).
 */

import { and, eq, isNull } from "drizzle-orm";

import { brands } from "@/modules/catalog/brand/schema";
import { categories } from "@/modules/catalog/category/schema";
import { DEMO_BRANDS } from "@/lib/demo/data";

import { CATALOG_TREE, type CatalogNode } from "./catalog-tree";
import { scriptDb, scriptPool } from "./script-client";

// The canonical tree lives in src/lib/db/catalog-tree.ts (shared with the
// one-click demo importer + the product importer so they can't drift).
const ROOT_CATEGORIES = CATALOG_TREE;

/**
 * Brands seeded with the catalog — the REAL Tokyo marques from the migration
 * data (shared with the demo seed, `src/lib/demo/data.ts`). The product import
 * also find-or-creates brands from the feed; adding more is admin-driven via
 * `/admin/catalog/brands`.
 */
const STARTER_BRANDS = DEMO_BRANDS;

/** Sibling-scoped lookup (parent null = roots only) — mirrors the demo
 *  importer's `categoryService.findBySlug(slug, parentId)` semantics. */
async function findBySlugUnderParent(slug: string, parentId: string | null): Promise<string | null> {
  const cond =
    parentId === null
      ? and(eq(categories.slug, slug), isNull(categories.parent_id))
      : and(eq(categories.slug, slug), eq(categories.parent_id, parentId));
  const [row] = await scriptDb.select().from(categories).where(cond).limit(1);
  return row?.id ?? null;
}

/** Recursive create-if-missing walk; sibling index = display_order. */
async function ensureLevel(nodes: CatalogNode[], parentId: string | null, depth: number): Promise<void> {
  for (const [index, node] of nodes.entries()) {
    let nodeId = await findBySlugUnderParent(node.slug, parentId);
    if (!nodeId) {
      const [inserted] = await scriptDb
        .insert(categories)
        .values({
          slug: node.slug,
          name: node.name,
          tagline: node.tagline ?? null,
          parent_id: parentId,
          display_order: index,
        })
        .returning();
      nodeId = inserted.id;
      console.log(`  ${"  ".repeat(depth)}+ ${node.slug}`);
    } else {
      if (depth === 0) console.log(`  · ${node.slug} (exists)`);
    }
    if (node.children?.length) await ensureLevel(node.children, nodeId, depth + 1);
  }
}

async function main() {
  console.log("[seed] catalog — category tree (tokyostore.tn)");
  await ensureLevel(ROOT_CATEGORIES, null, 0);

  console.log("[seed] catalog — brands");
  for (const b of STARTER_BRANDS) {
    const [existing] = await scriptDb.select().from(brands).where(eq(brands.slug, b.slug)).limit(1);
    if (!existing) {
      await scriptDb.insert(brands).values({ slug: b.slug, name: b.name });
      console.log(`  + ${b.slug}`);
    }
  }

  console.log("✓ Catalog seed complete.");
  await scriptPool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[seed] catalog failed", err);
  await scriptPool.end();
  process.exit(1);
});
