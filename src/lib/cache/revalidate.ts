import "server-only";

import { revalidateTag } from "next/cache";

import { clearTtlCache } from "./ttl";

/**
 * Immediately purge a `'use cache'` tag — the SINGLE source for cache-tag
 * busting across the `invalidate-*-cache` subscribers.
 *
 * Next 16's `revalidateTag` REQUIRES a second argument. A NAMED profile carries
 * that profile's `expire`, and the built-in "default" profile's expire is
 * `INFINITE_CACHE` (≈ 136 years) — so `revalidateTag(tag, "default")` only marks
 * the entry STALE (one stale-while-revalidate serve), it does NOT discard it.
 * Passing the CacheLifeConfig `{ expire: 0 }` writes `expired = now` in the cache
 * handler, so the entry is dropped and recomputed on the very next read
 * (immediate, read-your-writes). It also avoids the single-arg deprecation
 * warning. Verified against next@16.2.6 (revalidation-utils.js + default cache
 * handler updateTags).
 */
export function bustCacheTag(tag: string): void {
  // ORDER MATTERS. The process-level TTL purge runs FIRST because it CANNOT
  // throw; `revalidateTag` can. Outside a Next request/render context — a
  // bus.emit subscriber on a background tick, a cron job, a CLI script, or a
  // server ACTION that isn't rendering — `revalidateTag` throws "static
  // generation store missing". If it threw before clearTtlCache, the in-process
  // TTL cache (src/lib/cache/ttl.ts) would be left STALE for its full TTL on
  // exactly the mutation paths that run without a user request (e.g. the search
  // alias service invoked from an action). Purge the TTL cache first so a
  // tagged runtime cache (search aliases) clears in lock-step — read-your-writes
  // on the next request, never TTL-delayed — then best-effort revalidateTag.
  clearTtlCache(tag);
  try {
    revalidateTag(tag, { expire: 0 });
  } catch {
    /* not in a request/render context — the TTL purge above already ran */
  }
}
