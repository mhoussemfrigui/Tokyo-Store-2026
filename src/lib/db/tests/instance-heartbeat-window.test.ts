import "server-only";

/**
 * Uptime window read (instanceHeartbeatService.recent) — the Performance page's
 * « Disponibilité (historique) » must see every instance ALIVE in the window,
 * not just the ones that BOOTED in it:
 *
 *  • an instance booted before the window that died inside it is returned (the
 *    old `started_at >= since` filter dropped it, so its outage vanished and the
 *    view showed 100 % for a multi-day outage);
 *  • a row whose final beat predates the window but whose clean stop falls
 *    inside it is returned (stopped_at trails the last beat);
 *  • a row that ended entirely before the window is not;
 *  • fed to computeUptimeStats with the page's window, the carried-over
 *    instance's outage is counted and its successor is 1 restart.
 *
 * Self-cleaning (`__ihtest…` instance ids). Run ONLY against a throwaway DB:
 *   DATABASE_URL=postgresql://…:5440/tokyo BETTER_AUTH_SECRET=… EMAIL_PROVIDER=console \
 *     pnpm exec tsx --conditions=react-server src/lib/db/tests/instance-heartbeat-window.test.ts
 */
import { like, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { app_instance_heartbeats, instanceHeartbeatService } from "@/modules/instance";
import { computeUptimeStats } from "@/lib/telemetry/uptime";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const TAG = "__ihtest";
const DAY = 86_400_000;

async function cleanup() {
  await db
    .delete(app_instance_heartbeats)
    .where(like(app_instance_heartbeats.instance_id, `${TAG}%`));
}

/** Insert one heartbeat row with DB-clock offsets (days ago; null = unset). */
async function seed(
  suffix: string,
  startedDaysAgo: number,
  seenDaysAgo: number,
  stoppedDaysAgo: number | null,
) {
  const ago = (d: number) => sql`now() - make_interval(secs => ${d * 86_400})`;
  await db.insert(app_instance_heartbeats).values({
    instance_id: `${TAG}_${suffix}`,
    started_at: ago(startedDaysAgo),
    last_seen_at: ago(seenDaysAgo),
    stopped_at: stoppedDaysAgo == null ? null : ago(stoppedDaysAgo),
    build_sha: null,
  });
}

async function main() {
  await cleanup();

  await seed("carried_dead", 40, 5, null); // booted before the window, died on day −5
  await seed("ancient", 60, 45, null); // ended entirely before the window
  await seed("stop_in_window", 35, 30.5, 29); // last beat just outside, clean stop inside
  await seed("current", 2, 0, null); // booted on day −2, alive

  console.log("instanceHeartbeatService.recent(30) — rows overlapping the window:");
  const rows = (await instanceHeartbeatService.recent(30)).filter((r) =>
    r.instance_id.startsWith(TAG),
  );
  const ids = new Set(rows.map((r) => r.instance_id.slice(TAG.length + 1)));
  check("instance booted BEFORE the window that died inside it is returned", ids.has("carried_dead"));
  check("row whose clean stop falls inside the window is returned", ids.has("stop_in_window"));
  check("instance booted inside the window is returned", ids.has("current"));
  check("row that ended before the window is NOT returned", !ids.has("ancient"));
  check(
    "ordered oldest → newest start",
    rows.every((r, i) => i === 0 || rows[i - 1].started_at.getTime() <= r.started_at.getTime()),
  );

  console.log("computeUptimeStats over the carried-over + successor rows:");
  const nowMs = await instanceHeartbeatService.now();
  const windowStartMs = nowMs - 30 * DAY;
  const pair = rows.filter((r) => r.instance_id === `${TAG}_carried_dead` || r.instance_id === `${TAG}_current`);
  const stats = computeUptimeStats(
    pair.map((r) => ({ startedAt: r.started_at, lastSeenAt: r.last_seen_at, stoppedAt: r.stopped_at })),
    { heartbeatIntervalSec: 60, windowStartMs, nowMs },
  );
  check("the day −5 → day −2 outage is counted (≈ 3 days)", Math.abs(stats.downtimeMs - 3 * DAY) < 60_000);
  check("availability < 100 %", stats.availabilityPct < 100);
  check("the successor boot is 1 restart", stats.restarts === 1);

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    process.exit(1);
  })
  .then(() => process.exit(0));
