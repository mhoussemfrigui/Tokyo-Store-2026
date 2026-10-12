import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";

/**
 * App instance heartbeats — one row per Node process boot, refreshed on a
 * periodic heartbeat by the in-process runtime sampler (src/lib/telemetry/
 * runtime-metrics.ts). Drives the Infrastructure → Performance uptime/downtime
 * view: the live `process.uptime()` only knows the CURRENT process, so to infer
 * restarts + outage windows across redeploys we persist a tiny boot/heartbeat
 * trail. A gap between one instance's `last_seen_at` (or `stopped_at`) and the
 * next instance's `started_at` larger than ~2× the heartbeat interval is treated
 * as downtime.
 *
 * Bounded by boot frequency (one row per process start ≈ a handful per day even
 * under frequent redeploys) AND trimmed by the daily retention sweep
 * (`instanceHeartbeatService.purgeOlderThan(RETENTION_WINDOWS.instance_heartbeats)`,
 * 90 d) so it never grows unbounded.
 */
export const app_instance_heartbeats = pgTable(
  "app_instance_heartbeats",
  {
    id: id(),
    /** Random per-boot id (so replicas + restarts are distinguishable). */
    instance_id: text("instance_id").notNull(),
    /** When this process started (set once at first beat). */
    started_at: timestamp("started_at", { withTimezone: true }).notNull(),
    /** Refreshed on every heartbeat tick (the liveness signal). */
    last_seen_at: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    /** Set on a graceful SIGTERM/SIGINT drain (distinguishes clean stops). */
    stopped_at: timestamp("stopped_at", { withTimezone: true }),
    /** Build identifier (NEXT_PUBLIC_BUILD_SHA) for deploy traceability. */
    build_sha: text("build_sha"),
    ...timestamps(),
  },
  (t) => ({
    instanceUnique: uniqueIndex("app_instance_heartbeats_instance_uq").on(t.instance_id),
    // Window queries order by start time (restart count, downtime gaps).
    startedIdx: index("app_instance_heartbeats_started_idx").on(t.started_at),
  }),
);

export type InstanceHeartbeatRow = typeof app_instance_heartbeats.$inferSelect;
