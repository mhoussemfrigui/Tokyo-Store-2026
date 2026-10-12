import "server-only";

import { like } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { site_settings } from "@/modules/cms/setting/schema";
import {
  resolvePerformanceConfig,
  PERF_DEFAULTS,
  type PerfConfig,
} from "./perf-config";

/**
 * Process-level, short-TTL cache of the resolved performance/monitoring config —
 * mirrors src/lib/audit/runtime-config.ts. The in-process sampler reads this on
 * EVERY tick (to know the thresholds + whether to reschedule the interval) and
 * runs OUTSIDE any request, where React `cache()` (getSettingsMap) gives no
 * dedup. Caching here means at most one `SELECT … WHERE key LIKE 'perf.%'` per
 * TTL window.
 *
 * 15s TTL: an admin threshold/cadence change takes effect within ~15s. Fail-OPEN:
 * a read error serves the last-known config, or PERF_DEFAULTS — monitoring must
 * never silently stop because a settings read hiccupped.
 */

const TTL_MS = 15_000;

let cached: { cfg: PerfConfig; at: number } | null = null;
let inflight: Promise<PerfConfig> | null = null;

export async function getPerfRuntimeConfig(): Promise<PerfConfig> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.cfg;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await db
        .select({ key: site_settings.key, value: site_settings.value })
        .from(site_settings)
        .where(like(site_settings.key, "perf.%"));
      const map: Record<string, string | null> = Object.fromEntries(
        rows.map((r) => [r.key, r.value]),
      );
      const cfg = resolvePerformanceConfig(map);
      cached = { cfg, at: Date.now() };
      return cfg;
    } catch {
      return cached?.cfg ?? PERF_DEFAULTS;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Test / HMR hook — drop the cached config so the next read re-fetches. */
export function __resetPerfRuntimeConfig(): void {
  cached = null;
  inflight = null;
}
