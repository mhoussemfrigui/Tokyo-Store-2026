import "server-only";

import { and, eq, gte, lt, or, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { app_instance_heartbeats, type InstanceHeartbeatRow } from "./schema";

/**
 * Instance heartbeat store — see schema.ts. All methods are best-effort callers'
 * responsibility to guard; they throw on a real DB error so the sampler can log.
 */
class InstanceHeartbeatService {
  /**
   * Record/refresh this instance's heartbeat. First call inserts the boot row;
   * subsequent calls bump `last_seen_at`. Idempotent via the instance_id unique.
   *
   * CLOCK DISCIPLINE: all three timestamps (started_at, last_seen_at, stopped_at)
   * are written on the DB clock so the uptime gap math in uptime.ts never mixes
   * clocks. last_seen_at/stopped_at use now() directly; started_at is the DB clock
   * MINUS the elapsed-since-boot duration — `input.startedAt` is the app boot
   * instant, but `Date.now() - startedAt` is a pure DURATION (a difference of two
   * app-clock readings, so skew-free), and subtracting that from now() yields the
   * boot instant on the DB clock. Stamping started_at = now() naively would have
   * pinned it to first-beat time (~2s late) AND, since it stayed app-clock before,
   * left a real app↔DB skew in `next.started_at − prev.last_seen_at` gaps.
   */
  async beat(input: {
    instanceId: string;
    startedAt: Date;
    buildSha: string | null;
  }): Promise<void> {
    const elapsedSec = Math.max(0, (Date.now() - input.startedAt.getTime()) / 1000);
    await db
      .insert(app_instance_heartbeats)
      .values({
        instance_id: input.instanceId,
        started_at: sql`now() - make_interval(secs => ${elapsedSec})`,
        last_seen_at: sql`now()`,
        build_sha: input.buildSha,
      })
      .onConflictDoUpdate({
        target: app_instance_heartbeats.instance_id,
        set: { last_seen_at: sql`now()`, updated_at: sql`now()` },
      });
  }

  /**
   * The DB clock as epoch ms. The uptime gap math compares the heartbeat trail
   * (all DB-clock timestamps) against "now"; callers should use THIS as that now
   * so the trailing-gap (now − last_seen_at) stays on one clock instead of mixing
   * in the app clock. Throws on a real DB error so the caller can fall back.
   */
  async now(): Promise<number> {
    const res = await db.execute(sql`SELECT extract(epoch from now()) * 1000 AS ms`);
    const row = (res.rows as { ms: string | number }[])[0];
    return Math.round(Number(row?.ms ?? Date.now()));
  }

  /** Mark this instance cleanly stopped (graceful drain). */
  async markStopped(instanceId: string): Promise<void> {
    await db
      .update(app_instance_heartbeats)
      .set({ stopped_at: sql`now()`, updated_at: sql`now()` })
      .where(eq(app_instance_heartbeats.instance_id, instanceId));
  }

  /**
   * Heartbeat rows that OVERLAP the last `days` (alive at some point in it),
   * oldest → newest. Selecting on `started_at >= since` instead would drop an
   * instance booted BEFORE the window that died INSIDE it — its outage would
   * vanish from the uptime view (e.g. booted 40 d ago, dead on day −5, next boot
   * on day −2 → 100 % shown for a 3-day outage). A row overlaps when it was last
   * seen or cleanly stopped after `since` (stopped_at can trail the final beat).
   * `since` is on the DB clock, like every heartbeat timestamp.
   */
  async recent(days: number): Promise<InstanceHeartbeatRow[]> {
    const since = sql`now() - make_interval(days => ${Math.max(0, Math.ceil(days))})`;
    return db
      .select()
      .from(app_instance_heartbeats)
      .where(
        or(
          gte(app_instance_heartbeats.last_seen_at, since),
          gte(app_instance_heartbeats.stopped_at, since),
        ),
      )
      .orderBy(app_instance_heartbeats.started_at);
  }

  /**
   * Hygiene purge — drop heartbeats not seen within `days`. Returns rowCount.
   * The live instance is safe because `beat()` refreshes its `last_seen_at` to
   * now() each tick, so it can never satisfy `last_seen_at < cutoff`. The
   * `started_at < cutoff` conjunct is belt-and-braces (started_at <= last_seen_at
   * always holds — both are written on the DB clock and started_at = now()−elapsed
   * with elapsed >= 0, so it's implied) — kept only to make the intent explicit.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const res = await db
      .delete(app_instance_heartbeats)
      .where(
        and(
          lt(app_instance_heartbeats.last_seen_at, cutoff),
          lt(app_instance_heartbeats.started_at, cutoff),
        ),
      );
    return res.rowCount ?? 0;
  }
}

export const instanceHeartbeatService = new InstanceHeartbeatService();
