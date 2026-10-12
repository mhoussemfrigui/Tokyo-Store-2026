import "server-only";

import { revalidateTag } from "next/cache";
import { after } from "next/server";

import { CACHE_TAGS } from "./tags";
import { bustCacheTag } from "./revalidate";
import { clearTtlCache } from "./ttl";

/**
 * Whole-storefront cache bust for the BULK data paths — the product import, the
 * demo seed / clean / purge jobs and the détourage reprocess. Those write
 * through bulk module-service calls that emit no per-row `product.*` /
 * `brand.*` / `category.*` events, so the per-entity `invalidate-*` subscribers
 * never fire for them. Rather than chase individual tags, expire every catalog
 * + chrome tag a bulk job can touch: the operator runs a one-shot job, not a hot
 * path, and the cached reads recompute on next access.
 *
 * The SINGLE tag list for those paths (the demo route, the catalog cache
 * subscriber on `import.products_completed` / `demo.*`, and the job pollers all
 * use it) so it can't drift from the producers' actual tag strings.
 *
 * ⚠ Request context. `revalidateTag` only QUEUES the tag on the current
 * request's work store; Next applies the queue once, when the server action /
 * route handler finishes. A detached background runner (`void runX()` fired
 * from an action) outlives that flush, so a bust it emits is silently dropped
 * (or throws "used during render" once the action re-renders — swallowed).
 * That's why the job pollers re-bust from their OWN live request the first time
 * they see a job finished (`bustStorefrontForFinishedJobs`, via
 * `bustStorefrontForUnbustedJobs`); the subscriber call is best-effort (it
 * still purges the in-process TTL layer).
 */
export const STOREFRONT_BULK_TAGS = [
  CACHE_TAGS.products,
  CACHE_TAGS.productsList,
  CACHE_TAGS.categories,
  CACHE_TAGS.brands,
  CACHE_TAGS.attributes,
  CACHE_TAGS.banners,
  CACHE_TAGS.faqs,
  CACHE_TAGS.settings,
  CACHE_TAGS.nav,
  // A bulk job (détourage reprocess / import / demo) can repoint or delete a
  // média that a CMS page or blog post references, so their cached surfaces
  // must be busted too (mirrors invalidate-media-cache's broad bust).
  CACHE_TAGS.pages,
  CACHE_TAGS.blogPosts,
] as const;

/** Best-effort bust of every bulk-path tag. Never throws (see `bustCacheTag`). */
export function bustStorefrontCache(): void {
  for (const tag of STOREFRONT_BULK_TAGS) bustCacheTag(tag);
}

/**
 * Strict variant for callers that NEED to know whether the bust took: returns
 * `true` only when Next accepted `revalidateTag` here (a server action or route
 * handler — the tags are then expired when that request finishes), `false` when
 * called where it can't apply (a server-component render → Next throws E7; no
 * request at all → E263). The in-process TTL layer is purged either way.
 */
export function tryBustStorefrontCache(): boolean {
  for (const tag of STOREFRONT_BULK_TAGS) clearTtlCache(tag);
  try {
    for (const tag of STOREFRONT_BULK_TAGS) revalidateTag(tag, { expire: 0 });
    return true;
  } catch {
    return false;
  }
}

/** Minimal job shape the pollers hand over (an `import_jobs` projection). */
export type BustableJob = {
  id: string;
  status: string;
  result: object | null;
};

/**
 * A finished job whose storefront bust hasn't been applied yet: terminal, with a
 * result (a job that died before recording any result wrote nothing — or was
 * reaped after a restart, which already emptied the in-memory cache), and no
 * `cacheBustedAt` stamp.
 */
export function needsStorefrontBust(job: BustableJob): boolean {
  if (job.status !== "completed" && job.status !== "failed") return false;
  if (!job.result) return false;
  return (job.result as { cacheBustedAt?: unknown }).cacheBustedAt == null;
}

/**
 * Called through `bustStorefrontForUnbustedJobs` (bust-finished-jobs.ts) by the
 * job pollers (`listDataJobsAction`, `listImportJobsAction`,
 * `getReprocessJobStatusAction`) and the job pages' renders, with every recently
 * finished, not-yet-stamped job: the first time a finished job is observed from
 * a LIVE request, bust the whole storefront, then stamp the jobs (`markBusted` →
 * `result.cacheBustedAt`) so later polls don't bust again. Returns the ids
 * stamped synchronously.
 *
 * When the poller runs inside a server-component RENDER (the admin page's
 * initial job list — e.g. the operator left during the job and came back after
 * it finished, so the client never polls again) `revalidateTag` is refused
 * (E7); the bust is then deferred with `after()`, whose callbacks Next runs in
 * the 'after' phase and whose queued revalidations it applies. Outside any
 * request (CLI / test) nothing is busted or stamped.
 */
export async function bustStorefrontForFinishedJobs(
  jobs: readonly BustableJob[],
  markBusted: (ids: string[]) => Promise<string[]>,
): Promise<string[]> {
  const pending = jobs.filter(needsStorefrontBust).map((j) => j.id);
  if (pending.length === 0) return [];
  if (tryBustStorefrontCache()) return stampBusted(pending, markBusted);
  try {
    after(async () => {
      if (tryBustStorefrontCache()) await stampBusted(pending, markBusted);
    });
  } catch {
    // No request scope — nothing can be busted from here.
  }
  return [];
}

async function stampBusted(
  ids: string[],
  markBusted: (ids: string[]) => Promise<string[]>,
): Promise<string[]> {
  try {
    return await markBusted(ids);
  } catch (err) {
    // The bust itself already applied — a failed stamp only means a later poll
    // busts once more. Never fail the poll over it.
    console.error("[cache] job bust stamp failed", err);
    return [];
  }
}
