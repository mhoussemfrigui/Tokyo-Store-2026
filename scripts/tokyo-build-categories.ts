/**
 * Build the Tokyo Store category tree from the migration feed, so the product
 * import can map every feed breadcrumb onto a real (nested) category.
 *
 * The importer (`runProductImport`) MAPS feed category paths onto EXISTING
 * categories (live-index, parent-aware) and never creates them — so the tree
 * must exist first. We derive it from the SAME parser the importer uses
 * (`parseGoogleFeed`, which already drops the product-name tail of each
 * `g:product_type`), guaranteeing the tree matches what the import resolves.
 *
 * Also wipes the earlier watch-demo seed (categories + brands + products) so the
 * store is a clean Tokyo catalogue — "replace the demo data".
 *
 *   pnpm tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     scripts/tokyo-build-categories.ts "/home/mhoussem/Desktop/Tokyo Store Migration Data/tokyostore.xml"
 */
import fs from "node:fs";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { assertDestructiveTargetAllowed } from "./_safety-guard";
import { parseGoogleFeed } from "@/lib/import/parse-google-feed";
import { slugify } from "@/lib/slug";
import { categoryService } from "@/modules/catalog/category/service";

const FEED =
  process.argv[2] ?? "/home/mhoussem/Desktop/Tokyo Store Migration Data/tokyostore.xml";
const SEP = "\u0000";

async function main(): Promise<void> {
  assertDestructiveTargetAllowed(process.env.DATABASE_URL, "soft-delete ALL categories/brands/products");
  const xml = fs.readFileSync(FEED, "utf8");
  const { products, rowErrors } = parseGoogleFeed(xml);
  console.log(`[categories] parsed ${products.length} products (${rowErrors.length} row errors)`);

  // 1. Clean slate: soft-delete the watch-demo seed so only the Tokyo tree
  //    remains. (Products/brands are re-created by the import; links are
  //    re-established there.)
  await db.execute(sql`UPDATE categories SET deleted_at = now() WHERE deleted_at IS NULL`);
  await db.execute(sql`UPDATE brands SET deleted_at = now() WHERE deleted_at IS NULL`);
  await db.execute(sql`UPDATE products SET deleted_at = now() WHERE deleted_at IS NULL`);
  console.log("[categories] wiped previous catalogue (categories/brands/products)");

  // 2. Collect every node of every clean category path (all ancestor prefixes).
  const nodeKeys = new Set<string>();
  for (const p of products) {
    const segs = p.categoryPath;
    for (let i = 1; i <= segs.length; i += 1) nodeKeys.add(segs.slice(0, i).join(SEP));
  }
  // Parents before children (shallower depth first; stable by name after).
  const ordered = [...nodeKeys].sort((a, b) => {
    const da = a.split(SEP).length;
    const dbp = b.split(SEP).length;
    return da - dbp || a.localeCompare(b);
  });

  // 3. Create each node with a globally-unique slug (the flat /<slug> namespace
  //    forbids duplicate slugs even for same-named children under different
  //    parents — resolution stays correct because the importer's live index is
  //    parent-aware and matches on NAME, not slug).
  const usedSlugs = new Set<string>();
  const idByKey = new Map<string, string>();
  let created = 0;
  let order = 0;
  for (const key of ordered) {
    const segs = key.split(SEP);
    const name = segs[segs.length - 1];
    const parentKey = segs.slice(0, -1).join(SEP);
    const parentId = parentKey ? (idByKey.get(parentKey) ?? null) : null;

    let slug = slugify(name);
    if (!slug) slug = `cat-${order}`;
    if (usedSlugs.has(slug)) {
      const parentName = segs.length >= 2 ? segs[segs.length - 2] : "";
      let candidate = slugify(`${name}-${parentName}`);
      let n = 2;
      while (!candidate || usedSlugs.has(candidate)) candidate = slugify(`${name}-${parentName}-${n++}`);
      slug = candidate;
    }
    usedSlugs.add(slug);

    const row = await categoryService.insert({
      slug,
      name,
      parent_id: parentId,
      display_order: order,
    });
    idByKey.set(key, row.id);
    created += 1;
    order += 1;
  }

  const roots = [...idByKey.keys()].filter((k) => !k.includes(SEP)).length;
  console.log(`[categories] created ${created} categories (${roots} roots)`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
