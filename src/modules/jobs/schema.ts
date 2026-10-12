import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { id } from "@/lib/db/columns";

/**
 * Execution history for SCHEDULED / CRON jobs — one row per actual run of any
 * registered job (the internal review-generation scheduler, the external
 * retention purge, and future ones like mailing). Powers the admin
 * "Tâches planifiées" dashboard (status + logs). Distinct from `audit_log`
 * (operator actions) — this is machine job runs. `job_key` matches the code
 * registry in src/lib/jobs/registry.ts. Bounded per job by a prune-on-record.
 */
export const JOB_RUN_STATUSES = ["ok", "failed", "skipped"] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

/** How the run was triggered. */
export const JOB_RUN_TRIGGERS = ["schedule", "manual", "cron"] as const;
export type JobRunTrigger = (typeof JOB_RUN_TRIGGERS)[number];

export const job_run_log = pgTable(
  "job_run_log",
  {
    id: id(),
    job_key: text("job_key").notNull(),
    status: text("status").$type<JobRunStatus>().notNull(),
    trigger: text("trigger").$type<JobRunTrigger>().notNull().default("schedule"),
    started_at: timestamp("started_at", { withTimezone: true }).notNull(),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    duration_ms: integer("duration_ms"),
    /** Short human-readable outcome, e.g. "3 avis générés, 3 insérés". */
    summary: text("summary"),
    error: text("error"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    jobCreatedIdx: index("job_run_log_job_created_idx").on(t.job_key, t.created_at.desc()),
    // Serves the age-based retention purge (`WHERE created_at < …`, no job_key) —
    // the composite above can't (job_key leads). Migration 0074.
    createdIdx: index("job_run_log_created_idx").on(t.created_at),
  }),
);

export type JobRunLogRow = typeof job_run_log.$inferSelect;
export type NewJobRunLogRow = typeof job_run_log.$inferInsert;
