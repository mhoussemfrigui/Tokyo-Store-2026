import "server-only";

import { importJobService } from "@/modules/import";

import { bustStorefrontForFinishedJobs } from "./bust-storefront";

/**
 * The hook every admin job surface calls — the pollers (`listDataJobsAction`,
 * `listImportJobsAction`, `getReprocessJobStatusAction`) and the job pages'
 * server renders (through them, or directly for /admin/media/settings): bust
 * the storefront for EVERY recently finished, not-yet-busted job, whatever its
 * operation — not just the rows that surface happens to list. So a job no
 * poller watched to the end (a détourage reprocess the operator walked away
 * from — only its own card polls it) is still busted by the next admin job
 * page or poll. See `bustStorefrontForFinishedJobs` for the render → `after()`
 * deferral. Never throws: a failed lookup only means a later poll busts.
 */
export async function bustStorefrontForUnbustedJobs(): Promise<string[]> {
  try {
    const jobs = await importJobService.listFinishedUnbusted();
    return await bustStorefrontForFinishedJobs(jobs, (ids) => importJobService.markCacheBusted(ids));
  } catch (err) {
    console.error("[cache] finished-job bust lookup failed", err);
    return [];
  }
}
