-- ════════════════════════════════════════════════════════════════════════════
-- 0001 — import_jobs: background catalog-import jobs (XML/CSV → products)
-- ════════════════════════════════════════════════════════════════════════════
--
-- One row per uploaded feed file. The admin upload action inserts a `queued`
-- row and fires the runner without awaiting it; the admin panel polls this
-- table for progress (processed/total) and the terminal `result` report.
-- `source_content` holds the uploaded body and is NULLed once the job ends.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE "import_jobs" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "kind" text DEFAULT 'products' NOT NULL,
  "format" text NOT NULL,
  "filename" text NOT NULL,
  "status" text DEFAULT 'queued' NOT NULL,
  "source_content" text,
  "processed" integer DEFAULT 0 NOT NULL,
  "total" integer DEFAULT 0 NOT NULL,
  "result" jsonb,
  "error" text,
  "created_by" text,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "import_jobs_status_chk" CHECK ("status" IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT "import_jobs_format_chk" CHECK ("format" IN ('xml', 'csv')),
  CONSTRAINT "import_jobs_progress_nonneg_chk" CHECK ("processed" >= 0 AND "total" >= 0)
);
--> statement-breakpoint
CREATE INDEX "import_jobs_status_idx" ON "import_jobs" ("status");
--> statement-breakpoint
CREATE INDEX "import_jobs_created_idx" ON "import_jobs" ("created_at" DESC);
