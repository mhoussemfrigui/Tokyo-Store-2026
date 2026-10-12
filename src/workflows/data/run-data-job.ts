import "server-only";

import {
  emptyDataJobResult,
  importJobService,
  type DataJobResult,
  type DataSegment,
} from "@/modules/import";
import { runProductImportCore } from "@/workflows/import/run-product-import";
import { bus } from "@/events/bus";
import {
  cleanAttributes,
  cleanBanners,
  cleanBrands,
  cleanCategories,
  cleanCustomers,
  cleanFaqs,
  cleanNavigation,
  cleanProducts,
  cleanSettings,
  ensureCategoryTree,
  seedBanners,
  seedBrands,
  seedCategories,
  seedContentSnapshot,
  seedFaqs,
  seedNavigation,
  seedRedirects,
  seedSettings,
  type SegmentCtx,
} from "./segments";

/**
 * Background data-job runner (import + clean, any segment).
 *
 * The server action inserts a `queued` row and fires this WITHOUT awaiting
 * it (fire-and-forget) — the admin panel polls the row for progress. Like
 * `run-product-import.ts` it's a plain async function: nothing awaits the
 * return, all outcomes are persisted onto the job row (`markRunning` →
 * `updateProgress` → `complete` / `fail`).
 *
 * Dispatch is on `(operation, segment)`:
 *   • import + products → pre-seed the catalog tree, run the bundled product
 *     feed core (it re-points `markRunning` at the product total), then the
 *     old-URL redirects. One coherent terminal `complete`.
 *   • import + all       → the full bring-up: pre-seed the tree + the CMS
 *     content snapshot (so its `@@CAT@@` soft-links resolve), run the product
 *     feed core, then the redirects. One coherent terminal `complete`.
 *   • import + content   → markRunning(1), apply the content snapshot, complete.
 *   • import + <chrome>  → markRunning(1), run the single demo seed fn, complete.
 *   • clean  + <segment> → markRunning(1), run the clean fn, complete.
 *   • clean  + all       → clean in FK-safe order, accumulate `perSegment`,
 *     complete.
 *
 * Single-flight is enforced upstream (the action checks `hasActive`), so the
 * runner assumes it's the only job in flight. Authorization too: a `clean`
 * additionally requires the super-admin `*` wildcard (startDataJobAction).
 *
 * Cache: the seeds/cleans go through bulk module-service writes that emit no
 * per-row events, so every successful job ends with `demo.imported` /
 * `demo.cleared` (+ `import.products_completed` for products), on which the
 * catalog cache subscriber expires every storefront tag. This runner is
 * DETACHED, so that bust is best-effort (Next already flushed the triggering
 * request's revalidations); the authoritative one is `listDataJobsAction`, which
 * busts from its own live request the first time it sees the job finished.
 */

const LIST_CAP = 200;

/** FR labels for the public segments + the synthetic ones used by "all". */
const SEGMENT_LABELS: Record<string, string> = {
  products: "Produits",
  categories: "Catégories",
  brands: "Marques",
  banners: "Bannières",
  navigation: "Navigation",
  settings: "Réglages",
  faqs: "FAQ",
  attributes: "Attributs",
  customers: "Clients",
  product_faqs: "FAQ produits",
  home: "Page d'accueil",
  content: "Contenu",
  redirects: "Redirections",
  all: "Tout",
};

type SegmentFn = (ctx: SegmentCtx) => Promise<void>;

/**
 * Chrome pre-seeds that run BEFORE the product feed in a product-bearing import.
 * The catalog tree is a prerequisite (the feed's category mapper resolves slugs
 * against LIVE categories — it never creates them), and for the full bring-up
 * the CMS content snapshot lands first too so its `@@CAT@@` soft-links resolve
 * against the just-seeded tree. Products run last so the parse drives the bar;
 * redirects run AFTER products (their destinations must exist).
 */
// The catalog tree ONLY (`ensureCategoryTree`, not `seedCategories`) — the real
// bring-up never injects the DEMO category editorials / filter chips / FAQs; its
// content comes verbatim from the snapshot + the product feed.
const ALL_PRE_SEEDS: { segment: string; fn: SegmentFn }[] = [
  { segment: "categories", fn: ensureCategoryTree },
  { segment: "content", fn: seedContentSnapshot },
];
const PRODUCTS_PRE_SEEDS: { segment: string; fn: SegmentFn }[] = [
  { segment: "categories", fn: ensureCategoryTree },
];

/**
 * Clean order for `clean + all` — FK-safe: products (+ their links/media)
 * first, then everything that could still reference catalog rows, then
 * categories, then independent config last. ⚠ Store-wide: it also archives
 * EVERY customer profile — CLEAN_DESCRIPTIONS.all (segment-meta.ts) must keep
 * saying so. Média is reclaimed per segment only once nothing references it (a
 * banner image a home setting still uses is reclaimed by `cleanSettings` later).
 */
const CLEAN_ALL_ORDER: { segment: string; fn: SegmentFn }[] = [
  { segment: "products", fn: cleanProducts },
  { segment: "attributes", fn: cleanAttributes },
  { segment: "faqs", fn: cleanFaqs },
  { segment: "banners", fn: cleanBanners },
  { segment: "navigation", fn: cleanNavigation },
  { segment: "brands", fn: cleanBrands },
  { segment: "categories", fn: cleanCategories },
  { segment: "settings", fn: cleanSettings },
  { segment: "customers", fn: cleanCustomers },
];

/** Single-segment dispatch tables (the public 8; attributes/customers/etc.
 *  are only reachable via "all"). */
const SEED_ONE: Partial<Record<DataSegment, SegmentFn>> = {
  categories: seedCategories,
  brands: seedBrands,
  banners: seedBanners,
  navigation: seedNavigation,
  settings: seedSettings,
  faqs: seedFaqs,
  // The content snapshot as a standalone import (the "Import data › Contenu"
  // sub-tab). Not in DATA_SEGMENTS, so it never appears in the generic grid.
  content: seedContentSnapshot,
};

const CLEAN_ONE: Partial<Record<DataSegment, SegmentFn>> = {
  // `products` is offered as its own button in the CMS cleanup danger zone
  // (DataJobsPanel maps over every DATA_SEGMENTS entry). Unlike the import path,
  // clean has no products special-case, so without this entry the single-segment
  // "Nettoyer › Produits" always failed with "Segment non pris en charge". The
  // function is the same one "Tout nettoyer" runs.
  products: cleanProducts,
  categories: cleanCategories,
  brands: cleanBrands,
  banners: cleanBanners,
  navigation: cleanNavigation,
  settings: cleanSettings,
  faqs: cleanFaqs,
};

export async function runDataJob(jobId: string, actorUserId: string): Promise<void> {
  const job = await importJobService.findById(jobId);
  if (!job || job.status !== "queued") return; // re-entry / stale call guard

  const result = emptyDataJobResult();

  try {
    // ── import + (products | all) → pre-seed the catalog tree (+ the content
    //    snapshot for a full bring-up), run the real product feed, then the
    //    old-URL redirects. One coherent terminal `complete`.
    if (job.operation === "import" && (job.segment === "products" || job.segment === "all")) {
      const preSeeds = job.segment === "all" ? ALL_PRE_SEEDS : PRODUCTS_PRE_SEEDS;
      // Mark running up front so the row leaves `queued` with a fresh
      // updated_at — otherwise the pre-seed phase (no markRunning) could be
      // reaped by failStaleRunning. The product core re-points the total later.
      await importJobService.markRunning(jobId, preSeeds.length);
      let seeded = 0;
      for (const { segment, fn } of preSeeds) {
        await runSegment(segment, fn, { actorUserId, result });
        seeded += 1;
        await importJobService.updateProgress(jobId, seeded);
      }
      // Product core re-points markRunning at the product total and DOES NOT
      // complete the job (we own the combined terminal write). A parse
      // failure inside the core calls `fail` itself → bail without completing.
      const before = snapshot(result);
      const outcome = await runProductImportCore(jobId, actorUserId, result, {
        complete: false,
      });
      if (!outcome.ok) return; // core already failed the job (+ emitted products_failed)
      pushSegment(result, "products", diff(result, before));
      // Redirects LAST — the old product URLs point at the slugs just created.
      await runSegment("redirects", seedRedirects, { actorUserId, result });
      await emitImported(result, actorUserId);
      // Symmetric terminal for the audit stream: the core emitted
      // import.products_started but, with complete:false, NOT the completed event.
      await bus
        .emit(
          "import.products_completed",
          { jobId, created: result.created, updated: 0, failed: result.failed },
          { actorUserId },
        )
        .catch(() => {});
      await importJobService.complete(jobId, outcome.processed, capResult(result));
      return;
    }

    // ── clean + all → FK-safe order, accumulate perSegment.
    if (job.operation === "clean" && job.segment === "all") {
      await importJobService.markRunning(jobId, CLEAN_ALL_ORDER.length);
      let processed = 0;
      for (const { segment, fn } of CLEAN_ALL_ORDER) {
        await runSegment(segment, fn, { actorUserId, result });
        processed += 1;
        await importJobService.updateProgress(jobId, processed);
      }
      await emitCleared(result, actorUserId);
      await importJobService.complete(jobId, processed, capResult(result));
      return;
    }

    // ── single chrome segment (import or clean).
    const fn =
      job.operation === "import" ? SEED_ONE[job.segment] : CLEAN_ONE[job.segment];
    if (!fn) {
      // Unknown / unsupported (segment, operation) pairing — should never
      // happen (the action validates), but fail loudly rather than hang.
      await importJobService.fail(jobId, `Segment non pris en charge : ${job.segment}.`);
      return;
    }
    await importJobService.markRunning(jobId, 1);
    await runSegment(job.segment, fn, { actorUserId, result });
    await importJobService.updateProgress(jobId, 1);
    if (job.operation === "import") await emitImported(result, actorUserId);
    else await emitCleared(result, actorUserId);
    await importJobService.complete(jobId, 1, capResult(result));
  } catch (err) {
    // Unexpected crash — persist the failure WITH the partial result so the
    // operator sees what landed before the abort.
    console.error("[data-job] runner crashed", err);
    await importJobService
      .fail(jobId, err instanceof Error ? err.message : String(err), capResult(result))
      .catch(() => {});
  }
}

// ──────────────────────────────────────────────────────────────── helpers

/** Run one segment fn, recording its before/after delta into `perSegment`. */
async function runSegment(
  segment: string,
  fn: SegmentFn,
  ctx: SegmentCtx,
): Promise<void> {
  const before = snapshot(ctx.result);
  await fn(ctx);
  pushSegment(ctx.result, segment, diff(ctx.result, before));
}

type Counters = Pick<DataJobResult, "created" | "skipped" | "deleted" | "failed">;

function snapshot(r: DataJobResult): Counters {
  return { created: r.created, skipped: r.skipped, deleted: r.deleted, failed: r.failed };
}

function diff(r: DataJobResult, before: Counters): Counters {
  return {
    created: r.created - before.created,
    skipped: r.skipped - before.skipped,
    deleted: r.deleted - before.deleted,
    failed: r.failed - before.failed,
  };
}

function pushSegment(r: DataJobResult, segment: string, d: Counters): void {
  r.perSegment.push({
    segment,
    label: SEGMENT_LABELS[segment] ?? segment,
    created: d.created,
    skipped: d.skipped,
    deleted: d.deleted,
    failed: d.failed,
  });
}

/** Apply the 200-entry caps to every jsonb list before persisting. */
function capResult(r: DataJobResult): DataJobResult {
  r.unmappedPaths = capList(r.unmappedPaths);
  r.errors = capList(r.errors);
  r.warnings = capList(r.warnings);
  return r;
}

function capList(list: string[]): string[] {
  if (list.length <= LIST_CAP) return list;
  const extra = list.length - LIST_CAP;
  return [...list.slice(0, LIST_CAP), `… +${extra} autres`];
}

/** Mirror the demo workflows' terminal events so the audit/webhook subscribers
 *  and the catalog cache subscriber (best-effort from this detached runner —
 *  see the header) fire on a segmented run too. Best-effort — a bus failure
 *  never fails the job. */
async function emitImported(r: DataJobResult, actorUserId: string): Promise<void> {
  try {
    await bus.emit(
      "demo.imported",
      {
        brandsCreated: segmentCreated(r, "brands"),
        productsCreated: segmentCreated(r, "products"),
        bannersCreated: segmentCreated(r, "banners"),
        faqsCreated: segmentCreated(r, "faqs"),
        mediaCreated: r.mediaCreated,
      },
      { actorUserId },
    );
  } catch (err) {
    console.error("[data-job] demo.imported emit failed", err);
  }
}

async function emitCleared(r: DataJobResult, actorUserId: string): Promise<void> {
  try {
    await bus.emit(
      "demo.cleared",
      {
        brandsDeleted: segmentDeleted(r, "brands"),
        productsDeleted: segmentDeleted(r, "products"),
        bannersDeleted: segmentDeleted(r, "banners"),
        faqsDeleted: segmentDeleted(r, "faqs"),
        mediaDeleted: r.mediaDeleted,
      },
      { actorUserId },
    );
  } catch (err) {
    console.error("[data-job] demo.cleared emit failed", err);
  }
}

/**
 * Per-entity counts for the `demo.imported` / `demo.cleared` payloads. A segment
 * the job did not run reports 0 — NOT the job total (a « Nettoyer › Catégories »
 * job must not claim it deleted products/brands/banners/FAQs). Exported for the
 * data-jobs-cache regression test.
 */
export function segmentCreated(r: DataJobResult, segment: string): number {
  return r.perSegment.find((s) => s.segment === segment)?.created ?? 0;
}

export function segmentDeleted(r: DataJobResult, segment: string): number {
  return r.perSegment.find((s) => s.segment === segment)?.deleted ?? 0;
}
