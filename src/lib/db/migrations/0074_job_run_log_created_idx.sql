-- The daily retention purge deletes job_run_log rows by AGE
-- (`WHERE created_at < now() - interval`), with NO job_key filter. The only
-- existing index is (job_key, created_at DESC), whose leading column is job_key —
-- a B-tree can't serve a time-only range from it, so the purge falls back to a
-- seq scan. The table is small today (per-key keep-100 prune bounds it), so the
-- impact is minor, but this matches the codebase's indexing strategy and keeps
-- the purge cheap if the window is widened or the table grows.
CREATE INDEX IF NOT EXISTS "job_run_log_created_idx" ON "job_run_log" USING btree ("created_at");
