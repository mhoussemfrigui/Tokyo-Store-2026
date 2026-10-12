import "server-only";

/**
 * DB-backed test for search ALIASES / SYNONYMS (0114): the alias makes a query
 * that FOUND NOTHING actually match, through the real search engine (FTS +
 * trigram + the OR-ed expansion tsquery), plus the service CRUD + idempotent
 * default seed + the active-set cache bust.
 *
 * Self-contained (tagged product + tagged aliases); cleans only what it created.
 * Needs the dockerized DB. Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local src/lib/db/tests/search-aliases.test.ts
 */
import { like, or, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { search_aliases } from "@/modules/search/schema";
import { searchService } from "@/modules/search";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const TAG = "ztest-alias";

async function cleanup() {
  await db.delete(products).where(like(products.slug, `${TAG}%`));
  // The MANUAL aliases this test creates — a unique "zearbuds"→"ecouteurs" (the
  // "z" prefix keeps it clear of the SEEDED "earbuds" default that the end-of-test
  // block verifies) and the normalized "chrono"→"chronographe" (not a seeded term).
  // Deleting them by their own terms keeps the run idempotent WITHOUT ever wiping a
  // seeded default on a shared DB — the default set is cleaned separately, and only
  // if THIS run seeded it (see the tail of main()).
  await db
    .delete(search_aliases)
    .where(or(like(search_aliases.term, "zearbuds"), like(search_aliases.term, "chrono")));
}

/** Does a product with this slug appear among the product hits? The query is passed
 *  WITHOUT the fixture tag so a tag shared with the product name can't let trigram
 *  self-match and mask whether the ALIAS did the work. */
async function finds(query: string, slug: string): Promise<boolean> {
  const page = await searchService.search(query, { skipLog: true, limit: 50 });
  return page.products.some((p) => p.slug === slug);
}

async function main() {
  await cleanup();

  const slug = `${TAG}-ecouteurs`;
  await db.insert(products).values({
    slug,
    // Name contains « ecouteurs » but NOT the bare token « zearbuds », so only an
    // alias (zearbuds → ecouteurs) can bridge a « zearbuds » search to this product.
    name: "Ecouteurs sans fil Bluetooth",
    price_cents: 320000,
    in_stock: true,
    is_published: true,
    published_at: sql`now()`,
  } as never);

  console.log("baseline — « zearbuds » finds nothing (the title says « ecouteurs »):");
  check("« ecouteurs » DOES find the product (FTS)", await finds("ecouteurs", slug));
  check("« zearbuds » does NOT find it yet (no alias)", !(await finds("zearbuds", slug)));

  console.log("create a « zearbuds → ecouteurs » alias → the query now matches:");
  const created = await searchService.createAlias({ term: "zearbuds", expansion: "ecouteurs" });
  check("createAlias ok", created.ok === true);
  // The active-set cache was busted inside createAlias, so the next search sees it.
  check("« zearbuds » NOW finds the product (expanded to « ecouteurs »)", await finds("zearbuds", slug));
  check("« ecouteurs » still finds it (raw path unaffected)", await finds("ecouteurs", slug));

  console.log("dedupe + toggle + delete:");
  const dup = await searchService.createAlias({ term: "zearbuds", expansion: "ecouteurs" });
  check("duplicate (term,expansion) is refused, not thrown", dup.ok === false);
  const [row] = await db
    .select({ id: search_aliases.id })
    .from(search_aliases)
    .where(sql`${search_aliases.term} = 'zearbuds' AND ${search_aliases.expansion} = 'ecouteurs'`);
  await searchService.updateAlias(row.id, { isActive: false });
  check("a DEACTIVATED alias no longer expands", !(await finds("zearbuds", slug)));
  await searchService.updateAlias(row.id, { isActive: true });
  check("re-activating restores the expansion", await finds("zearbuds", slug));
  await searchService.deleteAlias(row.id);
  check("after delete, « zearbuds » finds nothing again", !(await finds("zearbuds", slug)));

  console.log("normalization on write (accents / case / spacing):");
  const acc = await searchService.createAlias({ term: "  CHRONO  ", expansion: "Chronographe" });
  check("createAlias normalizes the stored row", acc.ok === true);
  const norm = await db
    .select({ term: search_aliases.term, expansion: search_aliases.expansion })
    .from(search_aliases)
    .where(sql`${search_aliases.term} = 'chrono' AND ${search_aliases.expansion} = 'chronographe'`);
  check("stored term is lowercased + trimmed", norm.length === 1);
  await db
    .delete(search_aliases)
    .where(sql`${search_aliases.term} = 'zearbuds' AND ${search_aliases.expansion} = 'ecouteurs'`);

  console.log("default seed is idempotent:");
  // Snapshot current defaults so the re-seed delta is honest even if other rows exist.
  const before = (
    await db.select({ id: search_aliases.id }).from(search_aliases).where(sql`source = 'default'`)
  ).length;
  const firstAdd = await searchService.seedDefaultAliases();
  const afterFirst = (
    await db.select({ id: search_aliases.id }).from(search_aliases).where(sql`source = 'default'`)
  ).length;
  const secondAdd = await searchService.seedDefaultAliases();
  check("first seed inserted the defaults", firstAdd > 0 || before > 0);
  check("second seed adds ZERO (idempotent)", secondAdd === 0);
  check(
    "default row count stable across re-seed",
    afterFirst ===
      (
        await db
          .select({ id: search_aliases.id })
          .from(search_aliases)
          .where(sql`source = 'default'`)
      ).length,
  );
  // A seeded default (« earbuds → ecouteurs ») actually works end-to-end.
  check("a seeded default (« earbuds → ecouteurs ») expands the tagged product", await finds("earbuds", slug));

  // Clean the defaults ONLY if THIS test seeded them (before === 0) — never wipe a
  // store's own default set on a shared DB.
  if (before === 0) await db.delete(search_aliases).where(sql`source = 'default'`);
  await cleanup();
  console.log(`\nsearch-aliases.test.ts — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await cleanup();
  } catch {
    /* best-effort */
  }
  process.exit(1);
});
