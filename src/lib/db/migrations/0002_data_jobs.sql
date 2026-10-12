-- ════════════════════════════════════════════════════════════════════════════
-- 0002 — Generalize import_jobs into unified DATA JOBS (import|clean × segment)
-- ════════════════════════════════════════════════════════════════════════════
--
-- The same background-job + live-progress machinery now backs three things:
--   • file-upload product imports        (operation=import, segment=products, source=upload)
--   • segmented demo content seeding      (operation=import, source=demo)
--   • segmented data cleanup              (operation=clean, source=demo)
--
-- `format`/`filename` only apply to file uploads → made nullable. `operation`
-- / `segment` / `source` get safe defaults so existing inserts keep working.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "import_jobs" ADD COLUMN "operation" text DEFAULT 'import' NOT NULL;
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "segment" text DEFAULT 'products' NOT NULL;
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "source" text DEFAULT 'upload' NOT NULL;
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "title" text;
--> statement-breakpoint
ALTER TABLE "import_jobs" ALTER COLUMN "format" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "import_jobs" ALTER COLUMN "filename" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "import_jobs" DROP CONSTRAINT IF EXISTS "import_jobs_format_chk";
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_format_chk" CHECK ("format" IS NULL OR "format" IN ('xml', 'csv'));
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_operation_chk" CHECK ("operation" IN ('import', 'clean'));
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_source_chk" CHECK ("source" IN ('upload', 'demo'));
