import { index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * Data-jobs module — background jobs with live progress.
 *
 * One table (`import_jobs`, kept for back-compat) backs FOUR flows, all
 * polled by the admin for progress:
 *   • file-upload product imports     (operation=import,    segment=products, source=upload)
 *   • segmented demo content seeding   (operation=import,    source=demo)
 *   • segmented data cleanup           (operation=clean,     source=demo)
 *   • product white-bg reprocess       (operation=reprocess, segment=products, source=upload)
 *
 * The admin upload/seed/clean action inserts a `queued` row and fires the
 * runner WITHOUT awaiting it; the panel polls this table for status +
 * processed/total + the terminal `result` report. `source_content` holds an
 * uploaded/bundled feed body (NULLed on completion to free space).
 *
 * `created_by` is a text soft-link to better-auth `users.id`.
 */

export type ImportJobStatus = "queued" | "running" | "completed" | "failed";
export type ImportJobFormat = "xml" | "csv";
export type DataOperation = "import" | "clean" | "reprocess";
export type DataSource = "upload" | "demo";

/** The content segments a job can target. `all` fans out to every segment. */
export const DATA_SEGMENTS = [
  "products",
  "categories",
  "brands",
  "banners",
  "navigation",
  "settings",
  "faqs",
] as const;
/**
 * `"all"` fans out every segment; `"content"` applies the bundled CMS content
 * snapshot (settings/pages/banners/nav/FAQs/loyalty/business) verbatim. Both are
 * import-only composite targets — NOT members of `DATA_SEGMENTS`, so the generic
 * demo/clean grid (which maps over the array) never offers them; they are driven
 * by the dedicated "Import data" tab action.
 */
export type DataSegment = (typeof DATA_SEGMENTS)[number] | "all" | "content";

/**
 * Terminal report stored on the job row (rendered by the admin panel).
 * Generic over import + clean: a field is simply 0/absent when not relevant
 * (e.g. `deleted` for an import, `unmappedPaths` for a banner seed).
 */
export type DataJobResult = {
  created: number;
  skipped: number;
  failed: number;
  deleted: number;
  /** Brands find-or-created as a side effect of a product import. */
  brandsCreated: number;
  mediaCreated: number;
  mediaFailed: number;
  mediaDeleted: number;
  /** Feed category paths that couldn't be mapped onto the catalog tree. */
  unmappedPaths: string[];
  errors: string[];
  warnings: string[];
  /** Per-segment breakdown for a fan-out (`segment='all'`) job. */
  perSegment: Array<{
    segment: string;
    label: string;
    created: number;
    skipped: number;
    deleted: number;
    failed: number;
  }>;
};

/** @deprecated alias kept so existing product-import code compiles. */
export type ImportJobResult = DataJobResult;

/**
 * Fresh `DataJobResult` with every counter at 0 and every list empty — the
 * single source of truth for the result defaults. Used by the product-import
 * runner, the segmented data-job runner, and any partial-result construction
 * so no caller hand-rolls (and drifts from) the field set.
 */
export function emptyDataJobResult(): DataJobResult {
  return {
    created: 0,
    skipped: 0,
    failed: 0,
    deleted: 0,
    brandsCreated: 0,
    mediaCreated: 0,
    mediaFailed: 0,
    mediaDeleted: 0,
    unmappedPaths: [],
    errors: [],
    warnings: [],
    perSegment: [],
  };
}

export const import_jobs = pgTable(
  "import_jobs",
  {
    id: id(),
    /** "import" seeds/uploads rows; "clean" deletes them; "reprocess"
     *  re-processes existing media in place (e.g. product white-bg removal). */
    operation: text("operation").$type<DataOperation>().notNull().default("import"),
    /** Which content type this job targets (or "all"). */
    segment: text("segment").$type<DataSegment>().notNull().default("products"),
    /** "upload" = admin file; "demo" = bundled feed / seed data. */
    source: text("source").$type<DataSource>().notNull().default("upload"),
    /** Human label for the admin list (e.g. "Importer — Bannières"). */
    title: text("title"),
    // (The legacy write-only `kind` column was dropped in migration 0039.)
    /** Only set for file-upload imports. */
    format: text("format").$type<ImportJobFormat>(),
    filename: text("filename"),
    status: text("status").$type<ImportJobStatus>().notNull().default("queued"),
    /** Uploaded/bundled feed body; NULLed on completion/failure. */
    source_content: text("source_content"),
    processed: integer("processed").notNull().default(0),
    total: integer("total").notNull().default(0),
    result: jsonb("result").$type<DataJobResult>(),
    /** Fatal error that aborted the whole job. */
    error: text("error"),
    created_by: text("created_by"),
    started_at: timestamp("started_at", { withTimezone: true }),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => ({
    statusIdx: index("import_jobs_status_idx").on(table.status),
    createdIdx: index("import_jobs_created_idx").on(table.created_at.desc()),
  }),
);

export type ImportJobRow = typeof import_jobs.$inferSelect;
export type NewImportJobRow = typeof import_jobs.$inferInsert;
export type DataJobRow = ImportJobRow;
