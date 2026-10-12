-- Infrastructure → Performance: app instance heartbeats for uptime/downtime.
--
-- One row per Node process boot, refreshed periodically by the in-process
-- runtime sampler (src/lib/telemetry/runtime-metrics.ts). The live
-- `process.uptime()` only knows the current process; this trail lets the admin
-- infer restarts + outage windows across redeploys (a gap between one instance's
-- last_seen_at/stopped_at and the next instance's started_at > ~2× the heartbeat
-- interval = downtime). Bounded by boot frequency (a handful of rows/day even
-- under frequent redeploys) and trimmed by the daily retention sweep (90 d).
CREATE TABLE IF NOT EXISTS "app_instance_heartbeats" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "instance_id" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "stopped_at" timestamp with time zone,
  "build_sha" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "app_instance_heartbeats_instance_uq" ON "app_instance_heartbeats" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_instance_heartbeats_started_idx" ON "app_instance_heartbeats" USING btree ("started_at");
