"use server";

import { revalidatePath } from "next/cache";

import { parseCsvProducts } from "@/lib/import/parse-csv";
import { parseGoogleFeed } from "@/lib/import/parse-google-feed";
import { requirePermission } from "@/lib/auth/session";
import { isPurgeInProgress } from "@/lib/demo/purge-lock";
import { bustStorefrontForUnbustedJobs } from "@/lib/cache/bust-finished-jobs";
import { importJobService, type DataJobResult, type ImportJobFormat } from "@/modules/import";
import { runProductImport } from "@/workflows/import/run-product-import";

/**
 * Product-import server actions (`/admin/system/import`).
 *
 * `startProductImportAction` validates the upload, pre-parses it (cheap —
 * no DB writes) so obviously broken files bounce with a precise message,
 * inserts the `queued` job row, then kicks the detached runner WITHOUT
 * awaiting it — the request returns instantly and the panel polls
 * `listImportJobsAction` for progress.
 */

/** Serializable job projection the admin panel renders/polls. */
export type ImportJobView = {
  id: string;
  filename: string;
  format: "xml" | "csv";
  status: "queued" | "running" | "completed" | "failed";
  processed: number;
  total: number;
  result: DataJobResult | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB
/**
 * A `running`/`queued` job not touched for this long is presumed dead (deploy
 * restart). The runner bumps `updated_at` after every chunk (minutes apart at
 * most), so 15 min sits safely above a live job's update gap while cutting the
 * worst-case single-flight lockout from 60m → 15m.
 */
const STALE_RUNNING_MINUTES = 15;

export async function startProductImportAction(
  formData: FormData,
): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  const session = await requirePermission("system_import", "manage");

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Aucun fichier sélectionné." };
  }
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, message: "Fichier trop volumineux (8 Mo maximum)." };
  }

  const filename = file.name || "import";
  const lower = filename.toLowerCase();
  const format: ImportJobFormat | null = lower.endsWith(".xml")
    ? "xml"
    : lower.endsWith(".csv")
      ? "csv"
      : null;
  if (!format) {
    return { ok: false, message: "Format non supporté : un fichier .xml ou .csv est attendu." };
  }

  const content = await file.text();
  if (!content.trim()) {
    return { ok: false, message: "Le fichier est vide." };
  }

  // Cheap pre-validation (pure parsing, no DB writes): reject unreadable
  // files and empty feeds BEFORE creating a job, so the history list never
  // fills with dead-on-arrival entries.
  let productCount = 0;
  try {
    const parsed = format === "xml" ? parseGoogleFeed(content) : parseCsvProducts(content);
    productCount = parsed.products.length;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "fichier illisible";
    return { ok: false, message: `Fichier invalide : ${detail}` };
  }
  if (productCount === 0) {
    return { ok: false, message: "Aucun produit détecté dans le fichier." };
  }

  // Janitor first (a job orphaned by a redeploy would block the gate forever),
  // then the single-flight check — the runner is CPU/network heavy.
  await importJobService.failStaleRunning(STALE_RUNNING_MINUTES);
  if (await importJobService.hasActive()) {
    return { ok: false, message: "Un import est déjà en cours. Attendez la fin du job actuel." };
  }
  // A super-admin purge wipes the catalogue with no import_jobs row during its
  // destructive window — an import interleaved there would race its deletes
  // (and make the relaunch skip its own catalogue import).
  if (await isPurgeInProgress()) {
    return {
      ok: false,
      message: "Une réinitialisation des données est en cours. Réessayez quand elle est terminée.",
    };
  }

  // Authoritative single-flight gate (the hasActive() above is a fast path):
  // re-check + insert under a cluster-wide advisory lock.
  const job = await importJobService.createIfIdle({
    format,
    filename,
    source_content: content,
    created_by: session.user.id,
  });
  if (!job) {
    return { ok: false, message: "Un import est déjà en cours. Attendez la fin du job actuel." };
  }

  // Fire-and-forget: the action returns immediately; the runner persists all
  // outcomes onto the job row. The catch is a last-resort net for a throw
  // BEFORE the runner's own try/catch engages.
  void runProductImport(job.id, session.user.id).catch(async (err) => {
    console.error("[import] runner crashed", err);
    await importJobService
      .fail(job.id, err instanceof Error ? err.message : String(err))
      .catch(() => {});
  });

  revalidatePath("/admin/system/import-data");
  return { ok: true, jobId: job.id };
}

export async function listImportJobsAction(): Promise<ImportJobView[]> {
  await requirePermission("system_import", "view");
  // Catalog-upload page: only product-feed imports. The `import_jobs` table is
  // now shared with the segmented demo-seed / clean jobs (see
  // `data-jobs.ts`); those either carry a different operation or a null
  // `filename` (chrome segments), so filter to operation=import + a real
  // filename to keep this list scoped to file-upload + demo-product imports.
  const rows = await importJobService.listRecent(20, { operation: "import" });
  // First sighting of a finished job from a live request → bust the storefront
  // caches the detached runner couldn't (new brands, category counts…) — for
  // EVERY unbusted finished job, not just the imports listed here (a finished
  // détourage reprocess too). During the page's server render the bust is
  // deferred to `after()`.
  await bustStorefrontForUnbustedJobs();
  return rows.filter((row) => row.filename && row.format).map(toImportJobView);
}

/** DB row → serialisable `ImportJobView`. Module-local: a "use server" file
 *  may ONLY export async functions, so this mapper can't be exported — the
 *  page renders its initial list via `listImportJobsAction()` instead. */
function toImportJobView(
  row: Awaited<ReturnType<typeof importJobService.listRecent>>[number],
): ImportJobView {
  return {
    id: row.id,
    filename: row.filename ?? "import",
    format: row.format ?? "xml",
    status: row.status,
    processed: row.processed,
    total: row.total,
    result: row.result ?? null,
    error: row.error ?? null,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}
