/**
 * Performance smoke test.
 *
 *   pnpm db:bench:catalog [count]   # default 10_000
 *
 * Inserts N synthetic products + product_media + product_categories rows,
 * then runs EXPLAIN ANALYZE on the hottest queries to confirm the catalog
 * performance indexes (declared in schema.ts / the baseline migration) are
 * actually used. Prints a compact report. Idempotent: re-running tops up to
 * the target N.
 *
 * USE ONLY ON A DEV DB. Wipes nothing, but adds rows with `bench-` slugs.
 */

import { like, sql } from "drizzle-orm";

import { brands } from "@/modules/catalog/brand/schema";
import { categories } from "@/modules/catalog/category/schema";
import { products } from "@/modules/catalog/product/schema";
import { product_categories } from "@/associations/product-category";
import { MINOR_PER_DINAR } from "@/lib/price";
import { scriptDb, scriptPool } from "./script-client";

const TARGET = Number(process.argv[2] ?? 10_000);
const BATCH = 500;

const ADJECTIVES = [
  "Pro", "Ultra", "Edge", "Elite", "Prime", "Stealth", "Stage", "Aurora",
  "Rapid", "Volt", "Forge", "Frost", "Nova", "Apex", "Pulse", "Vortex",
];
const NOUNS = [
  "Controller", "Headset", "Mouse", "Keyboard", "Console", "Chair",
  "Monitor", "Webcam", "Mic", "Pad", "Hub", "Dock", "Charger", "Cable",
  "Stand", "Cooler",
];

function makeName(i: number): string {
  const a = ADJECTIVES[i % ADJECTIVES.length];
  const b = NOUNS[(i * 7) % NOUNS.length];
  return `GZ ${a} ${b} ${1000 + i}`;
}

async function ensureSeed() {
  // Need at least one brand and one category for product attachment.
  const [brand] = await scriptDb.select().from(brands).limit(1);
  if (!brand) {
    console.error("✗ No brands in DB. Run `pnpm db:seed:catalog` first.");
    process.exit(1);
  }
  const [cat] = await scriptDb.select().from(categories).limit(1);
  if (!cat) {
    console.error("✗ No categories in DB. Run `pnpm db:seed:catalog` first.");
    process.exit(1);
  }
  return { brandId: brand.id, categoryId: cat.id };
}

async function currentBenchCount(): Promise<number> {
  const [row] = await scriptDb
    .select({ value: sql<number>`COUNT(*)::int` })
    .from(products)
    .where(like(products.slug, "bench-%"));
  return Number(row?.value ?? 0);
}

async function insertBatch(start: number, end: number, categoryId: string) {
  const rows = [];
  for (let i = start; i < end; i++) {
    const name = makeName(i);
    rows.push({
      slug: `bench-${i.toString().padStart(7, "0")}`,
      name,
      short_desc: `Performance benchmark synthetic ${name}.`,
      description: `Long-form description for ${name}. Lorem ipsum dolor sit amet, consectetur adipiscing elit. ${Array.from({ length: 5 }).map(() => "Sed do eiusmod tempor incididunt.").join(" ")}`,
      price_cents: (50 + (i % 1500)) * MINOR_PER_DINAR,
      currency: "TND",
      in_stock: i % 7 !== 0,
      is_published: i % 11 !== 0,
      published_at: new Date(Date.now() - (i % 365) * 86_400_000),
    });
  }
  const inserted = await scriptDb.insert(products).values(rows).returning({ id: products.id });
  // Attach all to a single category for category-page perf tests.
  const links = inserted.map((p) => ({
    product_id: p.id,
    category_id: categoryId,
    is_primary: true,
  }));
  await scriptDb.insert(product_categories).values(links);
}

async function explain(label: string, query: string) {
  const out = await scriptDb.execute(sql.raw(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`));
  // pg returns the JSON plan as a string in the first column of the first row.
  const plan = (out.rows[0] as Record<string, unknown>)["QUERY PLAN"] as
    | Array<{ Plan: { "Total Cost": number }; "Execution Time": number }>
    | undefined;
  const root = plan?.[0];
  const cost = root?.Plan?.["Total Cost"]?.toFixed(1) ?? "?";
  const time = root?.["Execution Time"]?.toFixed(2) ?? "?";
  console.log(`  ${label.padEnd(40)} cost=${cost.padStart(10)}  exec=${time.padStart(8)}ms`);
}

async function bench() {
  console.log(`[bench] target row count: ${TARGET}`);
  const { categoryId } = await ensureSeed();

  let have = await currentBenchCount();
  console.log(`[bench] currently in DB: ${have}`);

  while (have < TARGET) {
    const end = Math.min(have + BATCH, TARGET);
    process.stdout.write(`  inserting ${have}..${end - 1}\r`);
    await insertBatch(have, end, categoryId);
    have = end;
  }
  console.log(`[bench] inserted up to ${have} products`);
  console.log();

  // Refresh planner stats for honest numbers.
  await scriptDb.execute(sql`ANALYZE products; ANALYZE product_categories;`);

  console.log("─── EXPLAIN ANALYZE on hot paths ──────────────────────");
  await explain(
    "listing (latest published)",
    `SELECT id, slug, name, price_cents FROM products
     WHERE deleted_at IS NULL AND is_published = true
     ORDER BY published_at DESC NULLS LAST LIMIT 24`,
  );
  await explain(
    "slug lookup",
    `SELECT * FROM products WHERE slug = 'bench-0000042' AND deleted_at IS NULL`,
  );
  // NOTE: product_categories.product_id and .category_id are text (no cross-
  // module FK per architectural rule), while products.id and categories.id are
  // uuid. We have to cast on both sides of the JOIN and the WHERE filter so
  // Postgres can apply the equality operator. The text indexes
  // (pc_product_idx, pc_category_idx) are still used because the cast collapses
  // back to text on the indexed column side.
  await explain(
    "category listing (via join)",
    `SELECT p.id, p.slug, p.name FROM products p
     JOIN product_categories pc ON pc.product_id = p.id
     WHERE pc.category_id = '${categoryId}'
       AND p.deleted_at IS NULL AND p.is_published = true
     ORDER BY p.published_at DESC NULLS LAST LIMIT 24`,
  );
  await explain(
    "price filter (cat + range)",
    `SELECT p.id, p.slug FROM products p
     JOIN product_categories pc ON pc.product_id = p.id
     WHERE pc.category_id = '${categoryId}'
       AND p.deleted_at IS NULL AND p.is_published = true
       AND p.price_cents BETWEEN 10000 AND 50000
     ORDER BY p.price_cents ASC LIMIT 24`,
  );
  await explain(
    "FTS search (tsvector @@)",
    `SELECT id, name, ts_rank(search_vector, q) AS r FROM products,
       to_tsquery('simple', 'pro:* & controller:*') q
     WHERE deleted_at IS NULL AND is_published = true
       AND search_vector @@ q
     ORDER BY r DESC LIMIT 20`,
  );
  await explain(
    "fuzzy search (pg_trgm)",
    `SELECT id, name, similarity(name, 'controler') AS s FROM products
     WHERE deleted_at IS NULL AND name % 'controler'
     ORDER BY s DESC LIMIT 20`,
  );
  await explain(
    "in-stock filter",
    `SELECT id, slug FROM products
     WHERE deleted_at IS NULL AND is_published = true AND in_stock = true
     ORDER BY published_at DESC NULLS LAST LIMIT 24`,
  );

  console.log();
  console.log("─── Index size summary ──────────────────────────────────");
  const sizes = await scriptDb.execute(sql`
    SELECT indexrelname AS index_name,
           pg_size_pretty(pg_relation_size(indexrelid)) AS size,
           idx_scan AS scans
    FROM pg_stat_user_indexes
    WHERE schemaname = 'public'
      AND relname IN ('products', 'product_categories', 'product_media', 'audit_log')
    ORDER BY pg_relation_size(indexrelid) DESC
    LIMIT 20;
  `);
  for (const row of sizes.rows as Array<{ index_name: string; size: string; scans: number }>) {
    console.log(`  ${row.index_name.padEnd(45)} ${row.size.padStart(10)}  scans=${row.scans}`);
  }

  console.log();
  console.log("✓ bench complete");
  await scriptPool.end();
  process.exit(0);
}

bench().catch(async (err) => {
  console.error("[bench] failed", err);
  await scriptPool.end();
  process.exit(1);
});
