/**
 * Backfill product SKUs to the migration feed's `g:id` (the store product code,
 * e.g. "TS-14051"). The original import set `sku = g:mpn`, which left 797
 * products with no SKU and diverged from `g:id` on 40 rows. This re-derives the
 * SKU from the SAME parser the importer uses (so slugs line up exactly) and
 * sets each live product's `sku` to its feed `g:id`.
 *
 * `g:id` is NOT unique across the feed (variant / duplicate rows), and
 * `products_sku_unique` is a partial-unique index (WHERE deleted_at IS NULL), so
 * a g:id already claimed by an earlier product is nulled on the later one —
 * exactly the importer's own 23505-retry behaviour. Products whose slug isn't in
 * the feed are left untouched. Idempotent; re-runnable.
 *
 *   pnpm tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     scripts/tokyo-backfill-sku.ts "/home/mhoussem/Desktop/Tokyo Store Migration Data/tokyostore.xml"
 */
import fs from "node:fs";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { parseGoogleFeed } from "@/lib/import/parse-google-feed";

const FEED =
  process.argv[2] ?? "/home/mhoussem/Desktop/Tokyo Store Migration Data/tokyostore.xml";

async function main(): Promise<void> {
  const xml = fs.readFileSync(FEED, "utf8");
  const { products: feed } = parseGoogleFeed(xml);

  // slug → g:id (first occurrence wins, mirroring the importer's seenSlugs).
  const idBySlug = new Map<string, string>();
  for (const p of feed) {
    if (p.sourceId && !idBySlug.has(p.slug)) idBySlug.set(p.slug, p.sourceId);
  }

  // Live products in import order (created_at asc) so the first product to claim
  // a duplicate g:id keeps it — the same one the importer would have kept.
  const rows = (
    await db.execute(
      sql`select id, slug, sku from products where deleted_at is null order by created_at asc, id asc`,
    )
  ).rows as { id: string; slug: string; sku: string | null }[];

  const usedSku = new Set<string>();
  let updated = 0;
  let nulledDup = 0;
  let unchanged = 0;
  let noFeedMatch = 0;

  await db.transaction(async (tx) => {
    // Clear every SKU first so reassigning a g:id can't transiently collide with
    // another row's OLD (mpn-based) SKU before that row is reprocessed — the
    // partial-unique index is checked per-statement, not at commit.
    await tx.execute(sql`update products set sku = null where deleted_at is null and sku is not null`);
    for (const r of rows) {
      const gid = idBySlug.get(r.slug);
      if (gid === undefined) {
        noFeedMatch += 1;
        // Not from this feed. Its SKU was cleared above; restore the original so
        // a manually-created product never loses its code. (0 such rows in a
        // fully feed-imported catalogue, but keeps the backfill non-destructive.)
        if (r.sku) await tx.execute(sql`update products set sku = ${r.sku} where id = ${r.id}::uuid`);
        continue;
      }
      if (usedSku.has(gid)) {
        nulledDup += 1; // duplicate g:id already claimed → stays null (cleared above)
        continue;
      }
      usedSku.add(gid);
      await tx.execute(sql`update products set sku = ${gid} where id = ${r.id}::uuid`);
      updated += 1;
    }
    void unchanged;
  });

  console.log(
    `[backfill-sku] products=${rows.length} updated=${updated} unchanged=${unchanged} ` +
      `nulled(dup g:id)=${nulledDup} no-feed-match=${noFeedMatch}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
