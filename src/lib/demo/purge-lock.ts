import "server-only";

import { settingService } from "@/modules/cms/setting/service";

/**
 * Cluster-wide, crash-evident single-flight marker for the destructive
 * "purge + relaunch demo" runner. A DB-row marker (not a connection-scoped
 * advisory lock) so it works across instances AND across the pooled connection
 * the detached runner uses.
 *
 * - confirmDemoPurgeAction sets it (beginPurge) before firing the runner, and
 *   refuses if already in progress → a 2nd super-admin can't fire a concurrent
 *   purge.
 * - startDataJobAction refuses while it is set → a (lesser-privileged)
 *   system_jobs operator can't interleave an import/clean during the lockless
 *   destructive window.
 * - The runner clears it (endPurge) in a finally, so a thrown error releases it.
 *   A HARD process kill mid-purge leaves it set, which is the desired
 *   crash-EVIDENCE — the marker auto-expires after STALE_MS so it can't wedge
 *   the feature forever, and a still-set marker tells the operator the previous
 *   purge died mid-run.
 */

const KEY = "demo.purge_in_progress";
const STALE_MS = 30 * 60 * 1000; // 30 min — well past a normal purge + feed import.

/** True if a purge is actively in progress (a non-stale marker exists). */
export async function isPurgeInProgress(): Promise<boolean> {
  const row = await settingService.findByKey(KEY);
  if (!row?.value) return false;
  const ts = Date.parse(row.value);
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts < STALE_MS;
}

/** Set the in-progress marker (timestamp = now). */
export async function beginPurge(): Promise<void> {
  await settingService.upsert({
    key: KEY,
    value: new Date().toISOString(),
    type: "text",
    group_key: "demo",
    label: "Purge démo en cours (marqueur transitoire)",
  });
}

/** Clear the in-progress marker. */
export async function endPurge(): Promise<void> {
  await settingService.deleteByKeys([KEY]);
}
