"use server";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/lib/auth/session";
import { checkSuperAdmin } from "@/lib/auth/super-admin";
import {
  DATA_SEGMENTS,
  importJobService,
  type DataJobResult,
  type DataOperation,
  type DataSegment,
} from "@/modules/import";
import { runDataJob } from "@/workflows/data/run-data-job";
import { runProductWhiteBgReprocess } from "@/workflows/media/reprocess-product-white-bg";
import { isPurgeInProgress } from "@/lib/demo/purge-lock";
import { bustStorefrontForUnbustedJobs } from "@/lib/cache/bust-finished-jobs";

/**
 * Segmented data-job server actions (`/admin/system/import-demo` +
 * `/admin/cms/settings`).
 *
 * `startDataJobAction` validates the (operation, segment) pair, requires the
 * super-admin `*` wildcard for a `clean` (irreversible, store-wide), runs the
 * stale-job janitor, enforces the GLOBAL single-flight gate, inserts a
 * `queued` row (pre-loading the bundled product feed for the product paths),
 * then kicks the detached runner WITHOUT awaiting it — the request returns
 * instantly and the panel polls `listDataJobsAction` for progress.
 *
 * The pollers also finish the storefront cache bust: a detached runner's own
 * `revalidateTag` is dropped (its request already flushed), so the first poll
 * that sees a job finished (any operation) busts the storefront tags from ITS
 * live request and stamps the job (`bustStorefrontForUnbustedJobs`).
 *
 * Mirrors `src/lib/actions/import.ts` (the file-upload product import) for
 * auth + single-flight; the two share the `import_jobs` table and the same
 * `DataJobResult` terminal report.
 */

/** Serializable job projection the admin panel renders/polls. */
export type DataJobView = {
  id: string;
  operation: "import" | "clean" | "reprocess";
  segment: string;
  source: string;
  title: string | null;
  status: "queued" | "running" | "completed" | "failed";
  processed: number;
  total: number;
  result: DataJobResult | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

/**
 * A `running`/`queued` job not touched for this long is presumed dead (deploy
 * restart). The runner bumps `updated_at` after every chunk (minutes apart at
 * most, even with image downloads), so 15 min is comfortably above a live job's
 * update gap while cutting the worst-case single-flight lockout from 60m → 15m.
 */
const STALE_RUNNING_MINUTES = 15;

/** The real Tokyo Store high-tech catalog (Google-feed XML) bundled into the
 *  image — fed to the product paths so the runner has data without an upload. */
const DEMO_FEED_PATH = path.join(process.cwd(), "public", "demo-assets", "tokyostore.xml");

/** FR label fragments for the job title ("Importer — Bannières"). */
const OPERATION_LABEL: Record<DataOperation, string> = {
  import: "Importer",
  clean: "Nettoyer",
  reprocess: "Re-traiter",
};
const SEGMENT_LABEL: Record<DataSegment, string> = {
  all: "Tout",
  content: "Contenu",
  products: "Produits",
  categories: "Catégories",
  brands: "Marques",
  banners: "Bannières",
  navigation: "Navigation",
  settings: "Réglages",
  faqs: "FAQ",
};

function isSegment(value: string): value is DataSegment {
  return (
    value === "all" ||
    value === "content" ||
    (DATA_SEGMENTS as readonly string[]).includes(value)
  );
}

export async function startDataJobAction(
  operation: "import" | "clean",
  segment: DataSegment,
): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  const session = await requirePermission("system_jobs", "manage");

  if (operation !== "import" && operation !== "clean") {
    return { ok: false, message: "Opération inconnue." };
  }
  if (!isSegment(segment)) {
    return { ok: false, message: "Segment inconnu." };
  }
  // A cleanup is IRREVERSIBLE and store-wide (every product with its reviews and
  // wishlists, every brand/banner/menu/FAQ… and « Tout » archives every customer
  // profile) — gate it like the purge: `system_jobs:manage` alone ("Tâches
  // planifiées") is not enough, the RBAC `*` wildcard is required too. Imports
  // stay on the module grant (idempotent, additive).
  if (operation === "clean" && !(await checkSuperAdmin(session.user.id))) {
    return {
      ok: false,
      message: "Le nettoyage des données est réservé aux super-administrateurs.",
    };
  }

  // Janitor first (a job orphaned by a redeploy would block the gate forever),
  // then the GLOBAL single-flight check — many ops touch overlapping tables.
  await importJobService.failStaleRunning(STALE_RUNNING_MINUTES);
  if (await importJobService.hasActive()) {
    return {
      ok: false,
      message: "Une opération est déjà en cours. Attendez la fin du job actuel.",
    };
  }
  // A super-admin PURGE wipes the same tables with no import_jobs row during its
  // destructive window — refuse to interleave a data-job (any operation) while
  // it runs, regardless of caller permission.
  if (await isPurgeInProgress()) {
    return {
      ok: false,
      message: "Une réinitialisation des données est en cours. Réessayez quand elle est terminée.",
    };
  }

  const title = `${OPERATION_LABEL[operation]} — ${SEGMENT_LABEL[segment]}`;

  // The product paths need feed content for the runner to parse. Read the
  // bundled feed up front so a missing asset bounces BEFORE a job row exists.
  let sourceContent: string | null = null;
  if (operation === "import" && (segment === "products" || segment === "all")) {
    try {
      sourceContent = await readFile(DEMO_FEED_PATH, "utf8");
    } catch (err) {
      console.error("[data-job] bundled feed missing", err);
      return {
        ok: false,
        message: "Catalogue de démonstration introuvable sur le serveur.",
      };
    }
  }

  // Authoritative single-flight gate: the hasActive() check above is only a fast
  // path — createIfIdle re-checks + inserts under a cluster-wide advisory lock,
  // so two near-simultaneous starts can't both get a row.
  const job = await importJobService.createIfIdle({
    operation,
    segment,
    source: "demo",
    title,
    // The product paths parse XML — stamp the format + a human filename so the
    // runner picks the XML parser and the admin list reads nicely.
    format: sourceContent ? "xml" : null,
    filename: sourceContent ? "Catalogue Tokyo Store (démo)" : null,
    source_content: sourceContent,
    created_by: session.user.id,
  });
  if (!job) {
    return {
      ok: false,
      message: "Une opération est déjà en cours. Attendez la fin du job actuel.",
    };
  }

  // Fire-and-forget: the action returns immediately; the runner persists all
  // outcomes onto the job row. The catch is a last-resort net for a throw
  // BEFORE the runner's own try/catch engages.
  void runDataJob(job.id, session.user.id).catch(async (err) => {
    console.error("[data-job] runner crashed", err);
    await importJobService
      .fail(job.id, err instanceof Error ? err.message : String(err))
      .catch(() => {});
  });

  // The Import-data console polls this list — bust it so the newly queued job appears.
  revalidatePath("/admin/system/import-data");
  return { ok: true, jobId: job.id };
}

export async function listDataJobsAction(
  operation?: "import" | "clean" | "reprocess",
): Promise<DataJobView[]> {
  await requirePermission("system_jobs", "view");
  const rows = await importJobService.listRecent(20, operation ? { operation } : {});
  // First sighting of a finished job from a live request → bust the storefront
  // caches the detached runner couldn't — for EVERY unbusted finished job, not
  // just this operation's rows (a finished détourage reprocess too). During the
  // page's server render the bust is deferred to `after()`.
  await bustStorefrontForUnbustedJobs();
  return rows.map((row) => ({
    id: row.id,
    operation: row.operation,
    segment: row.segment,
    source: row.source,
    title: row.title ?? null,
    status: row.status,
    processed: row.processed,
    total: row.total,
    result: row.result ?? null,
    error: row.error ?? null,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  }));
}

// ──────────────────────────────────────── product white-bg reprocess
//
// Enabling the `product_white_bg` media setting only détoures FUTURE uploads.
// This pair triggers + polls a one-off background job that re-processes the
// EXISTING product packshots in place (see `runProductWhiteBgReprocess`). It
// shares the `import_jobs` table + GLOBAL single-flight gate with the data
// jobs above, but lives behind `system_media` (the media-settings resource)
// since it's surfaced from the media-settings page, not the jobs console.

/** Minimal, JSON-serializable status the reprocess card polls every ~2s. */
export type ReprocessJobStatus = {
  status: "queued" | "running" | "completed" | "failed";
  processed: number;
  total: number;
  result: DataJobResult | null;
  error: string | null;
};

export async function startProductWhiteBgReprocessAction(): Promise<
  { ok: true; jobId: string } | { ok: false; message: string }
> {
  const session = await requirePermission("system_media", "update");

  // Janitor first (a job orphaned by a redeploy would block the gate forever),
  // then the GLOBAL single-flight check — the reprocess touches the same media
  // rows/objects an import would.
  await importJobService.failStaleRunning(STALE_RUNNING_MINUTES);
  if (await importJobService.hasActive()) {
    return {
      ok: false,
      message: "Une opération est déjà en cours. Attendez la fin du job actuel.",
    };
  }
  if (await isPurgeInProgress()) {
    return {
      ok: false,
      message: "Une réinitialisation des données est en cours. Réessayez quand elle est terminée.",
    };
  }

  const job = await importJobService.createIfIdle({
    operation: "reprocess",
    segment: "products",
    source: "upload",
    title: "Détourage des produits existants",
    created_by: session.user.id,
  });
  if (!job) {
    return {
      ok: false,
      message: "Une opération est déjà en cours. Attendez la fin du job actuel.",
    };
  }

  // Fire-and-forget: the action returns immediately; the runner persists all
  // outcomes onto the job row. The catch is a last-resort net for a throw
  // BEFORE the runner's own try/catch engages.
  void runProductWhiteBgReprocess(job.id, session.user.id).catch(async (err) => {
    console.error("[white-bg-reprocess] runner crashed", err);
    await importJobService
      .fail(job.id, err instanceof Error ? err.message : String(err))
      .catch(() => {});
  });

  return { ok: true, jobId: job.id };
}

export async function getReprocessJobStatusAction(
  jobId: string,
): Promise<ReprocessJobStatus | null> {
  await requirePermission("system_media", "view");
  const row = await importJobService.findById(jobId);
  if (!row) return null;
  // The reprocess repointed media at new `-nobg` keys and deleted the old
  // objects; its detached per-product bust is dropped, so bust from this live
  // poll the first time the job is seen finished (cached PDPs would 404). The
  // other job surfaces + the media-settings page render bust it too, for an
  // operator who left before the job ended.
  await bustStorefrontForUnbustedJobs();
  return {
    status: row.status,
    processed: row.processed,
    total: row.total,
    result: row.result ?? null,
    error: row.error ?? null,
  };
}
