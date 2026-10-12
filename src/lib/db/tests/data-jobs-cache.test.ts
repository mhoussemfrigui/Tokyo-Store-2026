import "server-only";

/**
 * Data / import jobs regression test (A–Z audit 2026-09-23, unit
 * « p3-data-jobs-cache »). Proves:
 *   1. Storefront cache busting for the BULK paths: the shared tag list, the
 *      "finished job needs a bust" rule, that nothing is stamped when the bust
 *      can't apply (no live request), and that the catalog cache subscriber now
 *      reacts to `import.products_completed` / `demo.imported` / `demo.cleared`
 *      / `demo.purged` (observed through the in-process TTL layer every
 *      `bustCacheTag` purges first).
 *   2. `demo.imported` / `demo.cleared` per-entity counts are 0 for a segment
 *      the job didn't run (no longer the job TOTAL).
 *   3. `importJobService.createIfIdle` is an ATOMIC single-flight gate: N
 *      concurrent starts → exactly one queued row (advisory xact lock).
 *   4. `importJobService.markCacheBusted` stamps a finished job with a result
 *      exactly once and never touches an active / result-less job; the pollers'
 *      `listFinishedUnbusted` lists EVERY operation's finished job (a détourage
 *      reprocess too), within the 1-day cacheLife window.
 *   5. A clean's `media.bulk_deleted` is attributed to the operator.
 *   6. Re-running the brand / category demo seeds NEVER overwrites the admin's
 *      editorial / SEO copy or category FAQs, fills only blank fields, and
 *      leaves a category the admin moved where it is.
 *
 * Self-cleaning (`zztest-djc` tag + the ids it created). Section 6 only runs on
 * a store with none of the demo brands / catalog-tree categories yet (it never
 * edits pre-existing rows).
 *
 * Run (isolated DB only):
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… pnpm exec tsx --conditions=react-server \
 *     --env-file-if-exists=.env.local src/lib/db/tests/data-jobs-cache.test.ts
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { registerCatalogCacheSubscriber } from "@/events/subscribers/invalidate-catalog-cache";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { ttlCached } from "@/lib/cache/ttl";
import {
  STOREFRONT_BULK_TAGS,
  bustStorefrontForFinishedJobs,
  needsStorefrontBust,
  tryBustStorefrontCache,
} from "@/lib/cache/bust-storefront";
import { bustStorefrontForUnbustedJobs } from "@/lib/cache/bust-finished-jobs";
import { CATALOG_TREE, walkCatalogTree } from "@/lib/db/catalog-tree";
import { DEMO_BRANDS, DEMO_CATEGORY_FAQS } from "@/lib/demo/data";
import { emptyDataJobResult, importJobService } from "@/modules/import";
import { import_jobs } from "@/modules/import/schema";
import { media } from "@/modules/media/schema";
import { brands } from "@/modules/catalog/brand/schema";
import { brandService } from "@/modules/catalog/brand/service";
import { categories } from "@/modules/catalog/category/schema";
import { categoryService } from "@/modules/catalog/category/service";
import { faqs } from "@/modules/cms/faq/schema";
import { faqService } from "@/modules/cms/faq/service";
import { segmentCreated, segmentDeleted } from "@/workflows/data/run-data-job";
import {
  fillBlankFields,
  reclaimUnreferencedMedia,
  seedBrands,
  seedCategories,
  type SegmentCtx,
} from "@/workflows/data/segments";

const TAG = "zztest-djc";
const ACTOR = `${TAG}-actor`;

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

const ctxOf = (): SegmentCtx => ({ actorUserId: ACTOR, result: emptyDataJobResult() });

/** Rows section 6 created (hard-removed in cleanup). */
const createdBrandIds: string[] = [];
const createdCategoryIds: string[] = [];

async function cleanup() {
  await db.delete(import_jobs).where(eq(import_jobs.created_by, TAG));
  await db.execute(sql`delete from media where storage_key like ${TAG + "/%"}`);
  if (createdCategoryIds.length) {
    await db.delete(faqs).where(inArray(faqs.category_id, createdCategoryIds));
    await db.delete(categories).where(inArray(categories.id, createdCategoryIds));
    createdCategoryIds.length = 0;
  }
  if (createdBrandIds.length) {
    await db.delete(brands).where(inArray(brands.id, createdBrandIds));
    createdBrandIds.length = 0;
  }
}

function catalogSlugs(): string[] {
  const out: string[] = [];
  walkCatalogTree(CATALOG_TREE, (node) => out.push(node.slug));
  return out;
}

async function main() {
  await cleanup();

  // ── 1. bust helpers + catalog subscriber ─────────────────────────────────
  console.log("bust-storefront helpers:");
  const tags = new Set<string>(STOREFRONT_BULK_TAGS);
  check(
    "bulk tag list covers catalog + chrome (categories/brands/products*/banners/nav/faqs)",
    [
      CACHE_TAGS.categories,
      CACHE_TAGS.brands,
      CACHE_TAGS.products,
      CACHE_TAGS.productsList,
      CACHE_TAGS.banners,
      CACHE_TAGS.nav,
      CACHE_TAGS.faqs,
    ].every((t) => tags.has(t)),
  );
  const done = { id: "a", status: "completed", result: emptyDataJobResult() };
  check("finished job with a result → needs a bust", needsStorefrontBust(done));
  check("failed job with a (partial) result → needs a bust", needsStorefrontBust({ ...done, status: "failed" }));
  check("running job → no bust yet", !needsStorefrontBust({ ...done, status: "running" }));
  check("result-less failure (wrote nothing) → no bust", !needsStorefrontBust({ ...done, status: "failed", result: null }));
  check(
    "already stamped → no second bust",
    !needsStorefrontBust({ ...done, result: { ...emptyDataJobResult(), cacheBustedAt: "2026-09-23T00:00:00Z" } }),
  );
  check("outside a request, the strict bust reports it could not apply", tryBustStorefrontCache() === false);
  let stampCalls = 0;
  const stamped = await bustStorefrontForFinishedJobs([done], async (ids) => {
    stampCalls++;
    return ids;
  });
  check("…and a poller outside a request stamps NOTHING (bust retried later)", stamped.length === 0 && stampCalls === 0);

  console.log("catalog cache subscriber reacts to the bulk-path events:");
  registerCatalogCacheSubscriber();
  let loads = 0;
  const cachedCategories = ttlCached(async () => ++loads, {
    ttlMs: 60 * 60_000,
    tags: [CACHE_TAGS.categories],
  });
  await cachedCategories();
  await cachedCategories();
  check("baseline: second read served from cache", loads === 1);
  const bulkEvents: Array<[string, () => Promise<void>]> = [
    [
      "import.products_completed",
      () => bus.emit("import.products_completed", { jobId: null, created: 1, updated: 0, failed: 0 }),
    ],
    [
      "demo.imported",
      () =>
        bus.emit("demo.imported", {
          brandsCreated: 0,
          productsCreated: 0,
          bannersCreated: 0,
          faqsCreated: 0,
          mediaCreated: 0,
        }),
    ],
    [
      "demo.cleared",
      () =>
        bus.emit("demo.cleared", {
          brandsDeleted: 0,
          productsDeleted: 0,
          bannersDeleted: 0,
          faqsDeleted: 0,
          mediaDeleted: 0,
        }),
    ],
    ["demo.purged", () => bus.emit("demo.purged", { ordersDeleted: 0, actorUserId: ACTOR })],
  ];
  for (const [name, fire] of bulkEvents) {
    const before = loads;
    await fire();
    await cachedCategories();
    check(`${name} → categories tag busted (re-read recomputes)`, loads === before + 1);
  }

  // Per-ENTITY single-write events → the entity's own cache tag (read-your-writes
  // for the nav strip + /brand resolver). The bulk loop above only pins the
  // seed/import paths; these pin the common single-edit path (an admin edits ONE
  // brand).
  console.log("catalog cache subscriber reacts to single-entity brand.* events:");
  let brLoads = 0;
  const cachedBrands = ttlCached(async () => ++brLoads, {
    ttlMs: 60 * 60_000,
    tags: [CACHE_TAGS.brands],
  });
  await cachedBrands();
  await cachedBrands();
  check("baseline: brands read served from cache", brLoads === 1);
  const brandEvents: Array<[string, () => Promise<void>]> = [
    ["brand.created", () => bus.emit("brand.created", { brandId: "zz-brand", slug: "zz" }, { actorUserId: ACTOR })],
    ["brand.updated", () => bus.emit("brand.updated", { brandId: "zz-brand", changedFields: ["display_order"] }, { actorUserId: ACTOR })],
    ["brand.deleted", () => bus.emit("brand.deleted", { brandId: "zz-brand" }, { actorUserId: ACTOR })],
  ];
  for (const [name, fire] of brandEvents) {
    const before = brLoads;
    await fire();
    await cachedBrands();
    check(`${name} → brands tag busted (re-read recomputes)`, brLoads === before + 1);
  }

  // ── 2. per-segment event counts ──────────────────────────────────────────
  console.log("demo.* per-entity counts:");
  {
    const r = emptyDataJobResult();
    r.deleted = 10;
    r.perSegment.push({ segment: "categories", label: "Catégories", created: 0, skipped: 0, deleted: 10, failed: 0 });
    check("categories-only clean: productsDeleted = 0 (not the total)", segmentDeleted(r, "products") === 0);
    check("categories-only clean: brandsDeleted = 0", segmentDeleted(r, "brands") === 0);
    check("the segment that ran keeps its own count", segmentDeleted(r, "categories") === 10);
    const imp = emptyDataJobResult();
    imp.created = 7;
    imp.perSegment.push({ segment: "banners", label: "Bannières", created: 7, skipped: 0, deleted: 0, failed: 0 });
    check("banners-only import: brandsCreated = 0", segmentCreated(imp, "brands") === 0);
    check("banners-only import: bannersCreated = 7", segmentCreated(imp, "banners") === 7);
  }

  // ── 3. atomic single-flight create ───────────────────────────────────────
  console.log("importJobService.createIfIdle (single-flight):");
  if (await importJobService.hasActive()) {
    check("precondition: no queued/running job on the test DB", false);
  } else {
    const racers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        importJobService.createIfIdle({ created_by: TAG, title: `${TAG}-race-${i}` }),
      ),
    );
    const winners = racers.filter((r): r is NonNullable<typeof r> => r !== null);
    check("6 concurrent starts → exactly ONE queued job", winners.length === 1);
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(import_jobs)
      .where(and(eq(import_jobs.created_by, TAG), inArray(import_jobs.status, ["queued", "running"])));
    check("…and exactly one active row in import_jobs", row.n === 1);
    check(
      "a start while it is queued is refused (null)",
      (await importJobService.createIfIdle({ created_by: TAG })) === null,
    );
    if (winners[0]) await importJobService.complete(winners[0].id, 0, emptyDataJobResult());
    const next = await importJobService.createIfIdle({ created_by: TAG, title: `${TAG}-next` });
    check("once it finished, the next start gets a row", next !== null);
    if (next) await importJobService.fail(next.id, "test");
  }

  // ── 4. one-time bust stamp ───────────────────────────────────────────────
  console.log("importJobService.markCacheBusted:");
  {
    const a = await importJobService.create({ created_by: TAG, title: `${TAG}-a` });
    const withResult = emptyDataJobResult();
    withResult.created = 3;
    await importJobService.complete(a.id, 3, withResult);
    const b = await importJobService.create({ created_by: TAG, title: `${TAG}-b` });
    await importJobService.fail(b.id, "no result");
    const c = await importJobService.create({ created_by: TAG, title: `${TAG}-c` });

    const first = await importJobService.markCacheBusted([a.id, b.id, c.id]);
    check("only the finished job WITH a result is stamped", first.length === 1 && first[0] === a.id);
    const aRow = await importJobService.findById(a.id);
    const aResult = aRow?.result as (typeof withResult & { cacheBustedAt?: string }) | null;
    check("stamp lands in result.cacheBustedAt", typeof aResult?.cacheBustedAt === "string");
    check("…without clobbering the report (created kept)", aResult?.created === 3 && Array.isArray(aResult?.errors));
    check("stamped job no longer needs a bust", aRow !== null && !needsStorefrontBust(aRow));
    check("second stamp is a no-op (bust happens once)", (await importJobService.markCacheBusted([a.id])).length === 0);
    const bRow = await importJobService.findById(b.id);
    check("result-less failed job untouched (result stays null)", bRow?.result === null);
    const cRow = await importJobService.findById(c.id);
    check("queued job untouched", cRow?.result === null && cRow?.status === "queued");
    await importJobService.fail(c.id, "test"); // never leave an active row behind
  }

  // ── 4b. every admin job surface busts EVERY finished job ─────────────────
  console.log("importJobService.listFinishedUnbusted (any operation):");
  {
    const listIds = async () =>
      new Set((await importJobService.listFinishedUnbusted(1000)).map((j) => j.id));
    // A détourage reprocess nobody watched to the end — the import / clean
    // pollers list other operations, but must still bust it.
    const rp = await importJobService.create({ created_by: TAG, operation: "reprocess", title: `${TAG}-rp` });
    await importJobService.complete(rp.id, 1, emptyDataJobResult());
    const bare = await importJobService.create({ created_by: TAG, title: `${TAG}-bare` });
    await importJobService.fail(bare.id, "no result");
    const active = await importJobService.create({ created_by: TAG, title: `${TAG}-active` });
    const old = await importJobService.create({ created_by: TAG, title: `${TAG}-old` });
    await importJobService.complete(old.id, 1, emptyDataJobResult());
    await db
      .update(import_jobs)
      .set({ finished_at: sql`now() - interval '2 days'` })
      .where(eq(import_jobs.id, old.id));

    let ids = await listIds();
    check("a finished reprocess job is listed (not operation-scoped)", ids.has(rp.id));
    check("result-less failed job not listed", !ids.has(bare.id));
    check("queued job not listed", !ids.has(active.id));
    check("job finished > 1 day ago not listed (cacheLife expired it)", !ids.has(old.id));
    check(
      "outside a request the shared hook stamps nothing",
      (await bustStorefrontForUnbustedJobs()).length === 0 && (await listIds()).has(rp.id),
    );
    await importJobService.markCacheBusted([rp.id]);
    ids = await listIds();
    check("once stamped, no longer listed", !ids.has(rp.id));
    await importJobService.fail(active.id, "test"); // never leave an active row behind
  }

  // ── 5. media.bulk_deleted actor ──────────────────────────────────────────
  console.log("reclaimUnreferencedMedia attributes media.bulk_deleted:");
  {
    let actor: string | null | undefined;
    bus.on("media.bulk_deleted", (env) => {
      if (env.payload.storageKeys.some((k) => k.startsWith(`${TAG}/`))) actor = env.actorUserId;
    });
    const [m] = await db
      .insert(media)
      .values({
        storage_key: `${TAG}/orphan.jpg`,
        url: `/cdn/${TAG}/orphan.jpg`,
        filename: "orphan.jpg",
        mime_type: "image/jpeg",
        size_bytes: 1,
      })
      .returning({ id: media.id });
    const ctx = ctxOf();
    await reclaimUnreferencedMedia(ctx, [m.id]);
    check("unreferenced média deleted", ctx.result.mediaDeleted === 1);
    check("event carries the operator as actor", actor === ACTOR);
  }

  // ── 6. re-seed never clobbers admin edits ────────────────────────────────
  console.log("fillBlankFields:");
  {
    const patch = fillBlankFields(
      { a: "admin", b: null as string | null, c: "  ", d: [] as string[], e: ["x"] },
      { a: "demo", b: "demo", c: "demo", d: ["demo"], e: ["demo"] },
    );
    check(
      "only blank / empty fields are patched",
      JSON.stringify(patch) === JSON.stringify({ b: "demo", c: "demo", d: ["demo"] }),
    );
  }

  console.log("seedBrands / seedCategories preserve admin edits:");
  const demoBrandSlugs = DEMO_BRANDS.map((b) => b.slug);
  const treeSlugs = catalogSlugs();
  const preBrands = await brandService.listBySlugs(demoBrandSlugs);
  const preCats = (await categoryService.listAll()).filter((c) => treeSlugs.includes(c.slug));
  if (preBrands.length > 0 || preCats.length > 0) {
    console.log("  (skipped — demo brands/categories already exist on this DB; never edits them)");
  } else {
    // Brands: first seed creates the marques; a re-seed never duplicates or
    // edits an admin's copy (editorials are no longer seeded — the migration data
    // carries none — so only the create-once + preserve-admin-edit rules remain).
    await seedBrands(ctxOf());
    const seededBrands = await brandService.listBySlugs(demoBrandSlugs);
    createdBrandIds.push(...seededBrands.map((b) => b.id));
    const sampleSlug = DEMO_BRANDS[0]?.slug;
    const sample = seededBrands.find((b) => b.slug === sampleSlug);
    check("first seed creates the demo marques", seededBrands.length === demoBrandSlugs.length);

    if (sample) {
      await brandService.update(sample.id, { meta_title: "Titre SEO admin", editorial_body: "Texte admin" });
      const ctx = ctxOf();
      await seedBrands(ctx);
      const [sample2] = await brandService.listBySlugs([sampleSlug]);
      check("re-seed creates no brand", ctx.result.created === 0);
      check("admin meta_title survives the re-seed", sample2?.meta_title === "Titre SEO admin");
      check("admin editorial_body survives the re-seed", sample2?.editorial_body === "Texte admin");
    }

    // Categories: first seed builds the migration taxonomy tree. Uses a known
    // leaf (« Casques » under Audiovisuel › Son) + a sibling section (« Photo »).
    await seedCategories(ctxOf());
    const seededCats = (await categoryService.listAll()).filter((c) => treeSlugs.includes(c.slug));
    createdCategoryIds.push(...seededCats.map((c) => c.id));
    const leaf = seededCats.find((c) => c.slug === "casques");
    const newParent = seededCats.find((c) => c.slug === "photo");
    const demoCatFaqs = DEMO_CATEGORY_FAQS.filter((f) => f.categorySlug === "casques").length;
    check("first seed builds the tree (a known leaf exists)", !!leaf);

    if (leaf && newParent) {
      const liveFaqCount = async () =>
        (
          await db
            .select({ id: faqs.id })
            .from(faqs)
            .where(and(eq(faqs.category_id, leaf.id), isNull(faqs.deleted_at)))
        ).length;
      check("no demo FAQs carried for the leaf", (await liveFaqCount()) === demoCatFaqs);

      await categoryService.update(leaf.id, { editorial_title: "Titre admin" });
      await faqService.insert({
        category_id: leaf.id,
        question: `${TAG} question admin`,
        answer: "Réponse admin",
        display_order: 50,
        is_published: true,
      });
      // The admin restructures: moves « Casques » under a different section.
      await categoryService.update(leaf.id, { parent_id: newParent.id, display_order: 99 });

      const ctx = ctxOf();
      await seedCategories(ctx);
      const leafRows = (await categoryService.listAll()).filter((c) => c.slug === "casques");
      check("admin editorial_title survives the re-seed", leafRows[0]?.editorial_title === "Titre admin");
      check(
        "admin FAQ still live and no demo FAQ re-inserted",
        (await liveFaqCount()) === demoCatFaqs + 1,
      );
      check("moved category NOT re-parented back", leafRows[0]?.parent_id === newParent.id);
      check("…nor its display order reset", leafRows[0]?.display_order === 99);
      check("…and no duplicate inserted", leafRows.length === 1);
      check(
        "operator warned the moved category was left in place",
        ctx.result.warnings.some((w) => w.includes("Casques")),
      );
      // Track any category the re-seed may have created (none expected).
      for (const c of (await categoryService.listAll()).filter((x) => treeSlugs.includes(x.slug))) {
        if (!createdCategoryIds.includes(c.id)) createdCategoryIds.push(c.id);
      }
    }
  }

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
