import "server-only";

import { db } from "@/lib/db/client";
import {
  productBrandLink,
  productCategoryLinks,
  productMediaLink,
} from "@/associations/catalog.service";
import { parseCsvProducts } from "@/lib/import/parse-csv";
import { parseGoogleFeed } from "@/lib/import/parse-google-feed";
import { buildLiveCategoryIndex, resolveCategorySlug } from "@/lib/import/category-map";
import type { ImportedProduct } from "@/lib/import/types";
import { slugify } from "@/lib/slug";
import { checkSlugAvailability } from "@/lib/utils/slug-conflict";
import { brandService } from "@/modules/catalog/brand/service";
import { categoryService } from "@/modules/catalog/category/service";
import type { CategoryRow } from "@/modules/catalog/category/schema";
import type { ProductRow } from "@/modules/catalog/product/schema";
import { productService } from "@/modules/catalog/product/service";
import {
  emptyDataJobResult,
  importJobService,
  type DataJobResult,
} from "@/modules/import";
import { importMediaFromUrlWorkflow } from "@/workflows/media/import-url";
import { isUniqueViolation, pgErrorConstraint } from "@/lib/db/pg-errors";
import { bus } from "@/events/bus";

/**
 * Detached product-import runner.
 *
 * The server action inserts a `queued` import_jobs row then calls this
 * WITHOUT awaiting (fire-and-forget) — the admin panel polls the row for
 * progress. Deliberately a PLAIN async function rather than the `workflow()`
 * envelope: nothing awaits its return value, so the ok/fail result shape
 * would be dead weight — all outcomes are persisted onto the job row
 * instead (`complete` / `fail`), including a partial result on a crash.
 *
 * Throughput model: items are processed in chunks of 4 via
 * `Promise.allSettled` — image download + sharp variant generation dominate
 * the wall clock, so modest parallelism helps a lot while keeping DB/S3
 * pressure low. Progress is persisted after EVERY chunk. An item-level
 * failure is recorded and never aborts the job.
 *
 * Result shape: writes the generic `DataJobResult` (shared with the seed/
 * clean data-jobs). Product-import only ever touches `created`/`skipped`/
 * `failed`/`brandsCreated`/`mediaCreated`/`mediaFailed`/`unmappedPaths`/
 * `errors`/`warnings`; `deleted`/`mediaDeleted`/`perSegment` keep their
 * 0/[] defaults.
 */

const CHUNK_SIZE = 4;
/** Max images linked per product (feed = 1 main + up to 7 additional). */
const MAX_IMAGES_PER_PRODUCT = 8;
/** Cap on each jsonb list so the job row stays small even on a 900-item feed. */
const LIST_CAP = 200;

/**
 * Outcome of {@link runProductImportCore} so the caller (the `all` data-job)
 * can fold the product counters into a multi-segment terminal report instead
 * of letting the core complete the job itself.
 */
export type ProductImportOutcome = {
  /** Number of feed items the runner actually walked (= processed/total). */
  processed: number;
  /** True when parsing/lifecycle succeeded; false means `fail` was already
   *  called on the job (the caller must NOT also complete it). */
  ok: boolean;
};

/**
 * Reusable product-import core.
 *
 *  - Owns parsing, `markRunning(total)`, chunked processing, and per-chunk
 *    `updateProgress`.
 *  - Mutates the SUPPLIED `result` so the `all` flow can pre-seed chrome
 *    counters and `perSegment` before products run.
 *  - When `complete` is true (the standalone products path), persists the
 *    terminal success itself. When false (the `all` path), it leaves the job
 *    `running` so the caller can attach the combined report.
 *  - A parse failure always calls `importJobService.fail` and returns
 *    `{ ok: false }` regardless of `complete`.
 */
export async function runProductImportCore(
  jobId: string,
  actorUserId: string,
  result: DataJobResult,
  opts: { complete: boolean } = { complete: true },
): Promise<ProductImportOutcome> {
  const job = await importJobService.findById(jobId);
  // Caller guarantees the job is live; `markRunning` may already have fired
  // for the `all` path, so we don't re-assert `status === "queued"` here.
  const unmappedPaths = new Set<string>();
  let backorderCount = 0;
  let processed = 0;

  /** Apply the 200-entry caps right before persisting the jsonb result. */
  const applyCaps = () => {
    result.unmappedPaths = capList([...unmappedPaths]);
    result.errors = capList(result.errors);
    result.warnings = capList(result.warnings);
  };

  // ── b. Parse (a parser throw is a whole-job failure)
  let products: ImportedProduct[];
  try {
    if (!job?.source_content) throw new Error("Contenu du fichier introuvable.");
    const parsed =
      job.format === "csv"
        ? parseCsvProducts(job.source_content)
        : parseGoogleFeed(job.source_content);
    products = parsed.products;
    result.errors.push(...parsed.rowErrors); // seed with row-level parse errors
  } catch (err) {
    applyCaps();
    await importJobService.fail(
      jobId,
      err instanceof Error ? err.message : String(err),
      result,
    );
    return { processed: 0, ok: false };
  }

  // ── c. Job goes live (total = item count drives the progress bar)
  await importJobService.markRunning(jobId, products.length);
  await bus.emit(
    "import.products_started",
    { jobId, source: job?.source ?? null },
    { actorUserId },
  );

  // ── d. Preloads + per-run caches
  const categories = await categoryService.listAll();
  const catById = new Map<string, CategoryRow>(categories.map((c) => [c.id, c]));
  const catBySlug = new Map<string, CategoryRow>();
  for (const c of categories) {
    // Sub-categories may legally reuse a root's slug — prefer the root.
    const existing = catBySlug.get(c.slug);
    if (!existing || (existing.parent_id !== null && c.parent_id === null)) {
      catBySlug.set(c.slug, c);
    }
  }
  // Feed category paths resolve against the store's LIVE categories first
  // (admin-created / renamed ones included), the static tree aliases second.
  const liveCategoryIndex = buildLiveCategoryIndex(categories);

  // Promise-valued caches so two items in the SAME chunk sharing a brand /
  // image URL trigger exactly one insert / one download (and one counter
  // increment, one warning) instead of racing each other.
  const brandIdCache = new Map<string, Promise<string | null>>();
  const mediaIdCache = new Map<string, Promise<string | null>>();
  // In-file duplicate slugs: first occurrence wins, the rest count as skips
  // (cheaper and quieter than letting the unique index reject them).
  const seenSlugs = new Set<string>();

  const resolveBrandId = (name: string): Promise<string | null> => {
    const slug = slugify(name);
    if (!slug) return Promise.resolve(null);
    let pending = brandIdCache.get(slug);
    if (!pending) {
      pending = (async () => {
        const existing = await brandService.findBySlug(slug);
        if (existing) return existing.id;
        // Cross-entity slug guard: the feed brand name could slugify onto a
        // slug already owned by a category/product/page/reserved route. The
        // admin workflows enforce this via checkSlugAvailability; the import is
        // the one write path that otherwise bypasses it, so apply it here too —
        // never mint a brand that the /[slug] resolver would shadow.
        const slugCheck = await checkSlugAvailability(slug);
        if (!slugCheck.ok) {
          result.warnings.push(`Marque « ${name.trim()} » ignorée : ${slugCheck.message}`);
          return null;
        }
        const created = await brandService.insert({ slug, name: name.trim() });
        result.brandsCreated += 1;
        return created.id;
      })();
      brandIdCache.set(slug, pending);
    }
    return pending;
  };

  const resolveMediaId = (url: string): Promise<string | null> => {
    let pending = mediaIdCache.get(url);
    if (!pending) {
      pending = (async () => {
        // SSRF-hardened download + full upload pipeline (EXIF strip, webp/
        // avif variants, S3, media row) — NEVER a raw fetch.
        const res = await importMediaFromUrlWorkflow({
          url,
          scope: "products",
          uploadedBy: actorUserId,
        });
        if (res.ok) {
          result.mediaCreated += 1;
          return res.data.mediaId;
        }
        result.mediaFailed += 1;
        result.warnings.push(`Image non importée (${res.message}) : ${url}`);
        return null;
      })();
      mediaIdCache.set(url, pending);
    }
    return pending;
  };

  const processItem = async (item: ImportedProduct): Promise<void> => {
    // Idempotency: a slug that already exists (previous import, manual
    // creation, or earlier in this same file) is skipped, never updated.
    if (seenSlugs.has(item.slug)) {
      result.skipped += 1;
      return;
    }
    seenSlugs.add(item.slug);
    const existing = await productService.findBySlug(item.slug);
    if (existing) {
      result.skipped += 1;
      return;
    }
    // Cross-entity slug guard (cheap same-table idempotency check above runs
    // first): never insert a product whose slug collides with a category /
    // brand / CMS page / reserved route — the /[slug] resolver would otherwise
    // silently shadow it. Mirrors the admin create/update workflows' guard.
    const slugCheck = await checkSlugAvailability(item.slug);
    if (!slugCheck.ok) {
      result.skipped += 1;
      result.warnings.push(`${item.slug} : ${slugCheck.message}`);
      return;
    }

    // backorder → sellable; summarized in ONE warning below.
    if (item.availability === "backorder") backorderCount += 1;
    const inStock = item.availability !== "out_of_stock";

    const description = item.description ?? "";

    // Resolve brand (find-or-create, cached) + the category ancestor chain
    // BEFORE the write tx — both are idempotent/pure and brand creation is
    // harmless if the product insert later rolls back.
    const brandId = item.brandName ? await resolveBrandId(item.brandName) : null;
    const targetSlug = resolveCategorySlug(item.categoryPath, item.title, liveCategoryIndex);
    const target = targetSlug ? catBySlug.get(targetSlug) : undefined;
    const chainIds: string[] = [];
    if (target) {
      let cursor: CategoryRow | undefined = target;
      while (cursor && !chainIds.includes(cursor.id)) {
        chainIds.push(cursor.id);
        cursor = cursor.parent_id ? catById.get(cursor.parent_id) : undefined;
      }
    } else if (item.categoryPath.length > 0) {
      unmappedPaths.add(item.categoryPath.join(" / "));
    }

    // ATOMIC: insert the product + its brand/category links in ONE transaction
    // so a crash can never leave a published product with no category/brand
    // (which findBySlug would then skip forever). Image links stay OUTSIDE the
    // tx — they do network I/O and an image-less product is acceptable.
    const baseValues = {
      slug: item.slug,
      name: item.title,
      short_desc: item.shortDesc ?? description,
      description,
      price_cents: item.priceMinor,
      old_price_cents: item.oldPriceMinor,
      currency: "TND" as const,
      in_stock: inStock,
      is_published: true,
      published_at: new Date(),
      meta_title: item.metaTitle,
      meta_description: item.metaDescription,
    };
    const insertWithLinks = (ids: { sku: string | null; gtin: string | null; mpn: string | null }) =>
      db.transaction(async (tx) => {
        const p = await productService.insert({ ...baseValues, ...ids }, tx);
        if (brandId) await productBrandLink.set(p.id, brandId, tx);
        if (target) await productCategoryLinks.set(p.id, chainIds, target.id, tx);
        return p;
      });

    let product: ProductRow;
    try {
      // SKU = the feed's g:id (the store's product code, e.g. "TS-14051"); fall
      // back to g:mpn for CSV rows that carry no sourceId. g:id is NOT unique in
      // the feed (variant/duplicate rows), so a collision with
      // products_sku_unique is caught below and retried with the id nulled.
      product = await insertWithLinks({ sku: item.sourceId ?? item.mpn, gtin: item.gtin, mpn: item.mpn });
    } catch (err) {
      // A real Google feed reuses MPN/GTIN across variant rows, and a value can
      // collide with an existing product — `products_{sku,gtin}_unique` raises
      // 23505 (Drizzle-wrapped; isUniqueViolation/pgErrorConstraint walk .cause).
      // Retry once with the identifiers nulled so the product still imports. Any
      // OTHER unique (e.g. a slug TOCTOU) is rethrown → a clean per-item failure.
      const constraint = pgErrorConstraint(err);
      const isIdentifierDup =
        isUniqueViolation(err) &&
        (constraint === undefined ||
          constraint === "products_sku_unique" ||
          constraint === "products_gtin_unique");
      if (isIdentifierDup) {
        result.warnings.push(
          `${item.slug} : identifiant (SKU/GTIN/MPN) en doublon — importé sans identifiant.`,
        );
        product = await insertWithLinks({ sku: null, gtin: null, mpn: null });
      } else {
        throw err;
      }
    }

    // The product + its links are committed — count it now so a later image
    // failure can't make a committed (and re-run-skipped) product count as
    // "failed". Images are best-effort: a failure degrades to an image-less
    // product + a warning, never a dropped/failed row.
    result.created += 1;
    try {
      const mediaIds: string[] = [];
      for (const url of item.imageUrls.slice(0, MAX_IMAGES_PER_PRODUCT)) {
        const mediaId = await resolveMediaId(url);
        if (mediaId) mediaIds.push(mediaId);
      }
      if (mediaIds.length > 0) {
        await productMediaLink.set(product.id, mediaIds, mediaIds[0]);
      }
    } catch (err) {
      result.warnings.push(
        `${item.slug} : images non attachées (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  };

  // ── e/f. Chunked processing + per-chunk progress persistence
  for (let i = 0; i < products.length; i += CHUNK_SIZE) {
    const chunk = products.slice(i, i + CHUNK_SIZE);
    const settled = await Promise.allSettled(chunk.map((item) => processItem(item)));
    settled.forEach((outcome, idx) => {
      if (outcome.status === "rejected") {
        result.failed += 1;
        const reason =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        result.errors.push(`${chunk[idx].slug}: ${reason}`);
      }
    });
    processed += chunk.length;
    await importJobService.updateProgress(jobId, processed);
  }

  if (backorderCount > 0) {
    result.warnings.push(
      `${backorderCount} produit(s) en « backorder » importé(s) comme disponibles (en stock).`,
    );
  }

  applyCaps();
  // ── g. Terminal success (standalone path only — the `all` flow completes
  //       the job itself after folding in the chrome perSegment report).
  if (opts.complete) {
    await importJobService.complete(jobId, processed, result);
    await bus.emit(
      "import.products_completed",
      { jobId, created: result.created, updated: 0, failed: result.failed },
      { actorUserId },
    );
  }
  return { processed, ok: true };
}

/**
 * Standalone product-import entry point (file-upload + `import + products`
 * data-job). Owns its own result object and the terminal `complete`/`fail`.
 */
export async function runProductImport(jobId: string, actorUserId: string): Promise<void> {
  const job = await importJobService.findById(jobId);
  if (!job || job.status !== "queued") return; // re-entry / stale call guard

  const result = emptyDataJobResult();
  try {
    await runProductImportCore(jobId, actorUserId, result, { complete: true });
  } catch (err) {
    // Unexpected crash — persist the failure WITH the partial result so the
    // operator sees what landed before the abort.
    console.error("[import] runner crashed", err);
    result.unmappedPaths = capList(result.unmappedPaths);
    result.errors = capList(result.errors);
    result.warnings = capList(result.warnings);
    await importJobService
      .fail(jobId, err instanceof Error ? err.message : String(err), result)
      .catch(() => {});
    // Terminal audit event so a run that emitted `import.products_started`
    // never dangles — only fired here because the core emits `started` after
    // `markRunning`; the pre-`markRunning` parse failure must NOT emit it.
    await bus.emit(
      "import.products_failed",
      { jobId, message: err instanceof Error ? err.message : String(err) },
      { actorUserId },
    );
  }
}

/** Keep at most LIST_CAP entries, appending a "… +N autres" sentinel. */
function capList(list: string[]): string[] {
  if (list.length <= LIST_CAP) return list;
  const extra = list.length - LIST_CAP;
  return [...list.slice(0, LIST_CAP), `… +${extra} autres`];
}
