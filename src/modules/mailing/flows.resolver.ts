import "server-only";

import { emailFlowService } from "./flows.service";
import { getEmailFlow } from "./flows.registry";

/**
 * Is an automation flow enabled right now? "DB `email_flows` row → its flag; else
 * registry `default_enabled`; unknown key → false". Every email subscriber/cron
 * checks this before sending so the admin Workflows tab can switch a flow off
 * without a deploy. Cached 30s (a burst fan-out shouldn't re-query per recipient);
 * the toggle action calls `invalidateFlowCache()`.
 */
let cache: { at: number; map: Map<string, boolean> } | null = null;
const TTL_MS = 30_000;

export function invalidateFlowCache(): void {
  cache = null;
}

export async function isFlowEnabled(key: string): Promise<boolean> {
  const def = getEmailFlow(key);
  if (!def) return false;
  let map: Map<string, boolean>;
  if (cache && Date.now() - cache.at < TTL_MS) {
    map = cache.map;
  } else {
    map = await emailFlowService.getOverridesMap().catch(() => new Map<string, boolean>());
    cache = { at: Date.now(), map };
  }
  const override = map.get(key);
  return override === undefined ? def.default_enabled : override;
}
