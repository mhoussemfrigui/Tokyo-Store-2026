import "server-only";

import { db } from "@/lib/db/client";
import { site_settings } from "@/modules/cms/setting/schema";
import { resolveAuditConfig, AUDIT_DEFAULTS, type AuditConfig } from "./parse-config";

/**
 * Process-level, short-TTL cache of the resolved audit/debug config for the
 * HOT subscriber path. The structured-logger + the two audit DB subscribers run
 * for EVERY bus emit; reading settings through React `cache()` (getSettingsMap)
 * only dedups within a request and re-queries the whole table for every
 * background/out-of-request emit. This caches the resolved config in-process so
 * the capture gate costs at most one `SELECT * FROM site_settings` per TTL
 * window, regardless of request scope.
 *
 * 15s TTL: short enough that toggling debug / log-level from the admin takes
 * effect almost immediately, long enough that a burst of events shares one read.
 * Fail-OPEN: a read error serves the last-known config, or AUDIT_DEFAULTS
 * (capture everything, info level) — auditing must never silently stop.
 */

const TTL_MS = 15_000;

let cached: { cfg: AuditConfig; at: number } | null = null;
let inflight: Promise<AuditConfig> | null = null;

export async function getAuditRuntimeConfig(): Promise<AuditConfig> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.cfg;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const rows = await db
        .select({ key: site_settings.key, value: site_settings.value })
        .from(site_settings);
      const map: Record<string, string | null> = Object.fromEntries(
        rows.map((r) => [r.key, r.value]),
      );
      const cfg = resolveAuditConfig(map);
      cached = { cfg, at: Date.now() };
      return cfg;
    } catch {
      return cached?.cfg ?? AUDIT_DEFAULTS;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Test / HMR hook — drop the cached config so the next read re-fetches. */
export function __resetAuditRuntimeConfig(): void {
  cached = null;
  inflight = null;
}
