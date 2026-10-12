import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { parseTrackingConfig, type TrackingConfig } from "./parse-config";

/**
 * Server-side loader for the admin-configured Tracking & Analytics settings
 * (`tracking.*` site_settings). The PURE parsing logic lives in `parse-config.ts`
 * (no DB, unit-tested); this module adds only the `server-only` settings read.
 * Mirrors src/lib/seo/config.ts (which pairs with settings-normalize.ts).
 *
 * Re-exports the pure surface so existing imports from "@/lib/tracking/config"
 * keep resolving.
 */

export * from "./parse-config";

/** Async loader (does its own settings read). Never throws — defaults survive a DB outage. */
export async function getTrackingConfig(): Promise<TrackingConfig> {
  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    /* keep defaults */
  }
  return parseTrackingConfig(s);
}
