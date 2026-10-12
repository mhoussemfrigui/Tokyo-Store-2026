import "server-only";

import { getSettingsMap } from "@/modules/cms/setting/queries";
import { resolveSearchConfig, type SearchConfig } from "./parse-config";

/**
 * Server-side loader for the admin-configured search settings (`search.*`
 * site_settings). The PURE parsing/clamping logic lives in `parse-config.ts`
 * (no DB, unit-tested); this module adds only the `server-only` settings read.
 * Mirrors src/lib/tracking/config.ts and src/lib/seo/config.ts.
 *
 * Re-exports the pure surface so callers can import everything from one place.
 */

export * from "./parse-config";

/**
 * Async loader (does its own React-cached settings read). Never throws —
 * defaults survive a DB outage so the search box keeps working.
 */
export async function getSearchConfig(): Promise<SearchConfig> {
  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    /* keep defaults */
  }
  return resolveSearchConfig(s);
}
