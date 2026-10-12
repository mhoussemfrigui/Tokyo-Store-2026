import "server-only";

/**
 * Process-level TTL memoization for VISITOR-INDEPENDENT reads.
 *
 * Currently the one consumer is the semantic-search query-embedding cache
 * (`src/modules/search/service.ts`): the same query string always embeds to the
 * same vector, so caching it for an hour turns repeat searches into zero API
 * calls. It is deliberately a plain module-level Map rather than `'use cache'`:
 * a `'use cache'` wrapper on a layout-reachable loader flips otherwise-dynamic
 * storefront routes toward static prerender, which the no-DB Docker build then
 * tries to execute at build time and fails (see the isBuildPhase() note in
 * src/lib/api/categories.ts). A module-level Map has ZERO build-time interaction:
 * the wrapped fn still `await`s on a miss, so Next keeps the route dynamic — the
 * caching is a purely RUNTIME, cross-request layer between React `cache()`
 * (per-request) and Next's `'use cache'` (per-tag, build-coupled).
 *
 * SAFETY (must hold for anything wrapped here):
 *  - result MUST NOT depend on cookies()/headers()/the specific visitor/session.
 *  - NEVER wrap the checkout charge / stock-settlement path — those must read the
 *    LIVE price + availableQty under FOR UPDATE (a cached snapshot = TOCTOU
 *    oversell). Only deterministic, visitor-independent reads belong here.
 *
 * FRESHNESS: entries expire after `ttlMs`. Tagged caches are ALSO purged
 * instantly by `clearTtlCache(tag)`, which `bustCacheTag` (src/lib/cache/revalidate.ts)
 * calls FIRST on every tag bust. The live tagged consumer is `loadActiveAliases`
 * (src/modules/search/service.ts, tag `CACHE_TAGS.searchAliases`): editing an alias
 * busts that tag, so the change takes effect on the next search with no wait for the
 * TTL to lapse. The query→embedding cache carries no tags (a query always embeds to
 * the same vector), so it relies on `ttlMs` alone.
 */

type Entry = { value: Promise<unknown>; expires: number };
type Store = { entries: Map<string, Entry>; tags: string[]; max: number };

// Registry of every cache created, so clearTtlCache can purge by tag.
const stores = new Set<Store>();

export interface TtlOptions<A extends unknown[]> {
  /** Backstop lifetime in ms. */
  ttlMs: number;
  /** Tags this cache responds to — matched by clearTtlCache. */
  tags?: string[];
  /** Cache key from args (default: JSON of args; "_" for the no-arg case). */
  key?: (...args: A) => string;
  /** Max distinct keys retained (FIFO eviction) — bounds memory for keyed caches. */
  max?: number;
}

/** Read PER CALL, not once at load, so a test can flip the flag before driving the
 *  cache. Cost is one property read on a path that already does a Map lookup. */
function ttlCacheDisabled(): boolean {
  return process.env.TTL_CACHE_DISABLED === "1";
}

export function ttlCached<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>,
  opts: TtlOptions<A>,
): (...args: A) => Promise<T> {
  const store: Store = {
    entries: new Map<string, Entry>(),
    tags: opts.tags ?? [],
    max: opts.max ?? 0,
  };
  stores.add(store);
  const keyOf = opts.key ?? ((...a: A) => (a.length ? JSON.stringify(a) : "_"));

  return (...args: A): Promise<T> => {
    const k = keyOf(...args);
    const now = Date.now();
    // Opt-in test escape hatch (OFF by default): a standalone test process that
    // sets TTL_CACHE_DISABLED=1 bypasses the cache so it never reads a stale
    // value it wrote directly (bypassing the admin bust path). Production untouched.
    if (ttlCacheDisabled()) return Promise.resolve().then(() => fn(...args));
    const hit = store.entries.get(k);
    if (hit && hit.expires > now) return hit.value as Promise<T>;

    // Store the in-flight PROMISE (not the awaited value) so concurrent callers
    // dedupe onto ONE fetch — stampede protection when a cache entry expires
    // under load. A rejection is never cached: the entry self-evicts on error so
    // the next call retries (mirrors the caller-side `.catch(fallback)` guards).
    const p = Promise.resolve()
      .then(() => fn(...args))
      .catch((err) => {
        if (store.entries.get(k)?.value === p) store.entries.delete(k);
        throw err;
      });
    store.entries.set(k, { value: p, expires: now + opts.ttlMs });

    if (store.max > 0 && store.entries.size > store.max) {
      const oldest = store.entries.keys().next().value;
      if (oldest !== undefined) store.entries.delete(oldest);
    }
    return p as Promise<T>;
  };
}

/**
 * Purge cached entries whose tag set includes `tag` (or ALL entries when `tag`
 * is omitted). Cheap and synchronous. Wired into `bustCacheTag`
 * (src/lib/cache/revalidate.ts), which calls it on every tag bust — the tagged
 * consumer is `loadActiveAliases` on `CACHE_TAGS.searchAliases`.
 */
export function clearTtlCache(tag?: string): void {
  for (const store of stores) {
    if (!tag || store.tags.includes(tag)) store.entries.clear();
  }
}
