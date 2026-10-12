/**
 * The process-level TTL memoizer (src/lib/cache/ttl.ts) — NO database. It backs
 * the semantic-search query-embedding cache and the search-alias cache, so its
 * contract is load-bearing for API cost and for admin edits taking effect:
 *
 *   - memoizes per key (default key = JSON of the args), and concurrent callers
 *     share ONE in-flight fetch (stampede protection);
 *   - an entry expires after `ttlMs`;
 *   - a rejection is never cached (the next call retries);
 *   - `max` bounds a keyed cache with FIFO eviction;
 *   - `clearTtlCache(tag)` purges only the stores carrying that tag,
 *     `clearTtlCache()` purges every store;
 *   - `TTL_CACHE_DISABLED=1` (the opt-in test escape hatch, read PER CALL)
 *     bypasses the cache entirely and never populates it.
 *
 * Tag-bust wiring through `bustCacheTag` is covered by data-jobs-cache /
 * media-safety / reviews-showcase.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/ttl-cache.test.ts
 */
import { clearTtlCache, ttlCached } from "@/lib/cache/ttl";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  delete process.env.TTL_CACHE_DISABLED;

  console.log("memoization + in-flight dedupe:");
  let calls = 0;
  const square = ttlCached(
    async (n: number) => {
      calls++;
      await sleep(5);
      return n * n;
    },
    { ttlMs: 60_000 },
  );
  const [a, b] = await Promise.all([square(3), square(3)]);
  check("concurrent callers share one fetch", a === 9 && b === 9 && calls === 1);
  check("a repeat call is a hit", (await square(3)) === 9 && calls === 1);
  check("another key is a separate entry", (await square(4)) === 16 && calls === 2);

  console.log("expiry:");
  let ticks = 0;
  const shortLived = ttlCached(async () => ++ticks, { ttlMs: 20 });
  await shortLived();
  await shortLived();
  check("within the TTL: one fetch", ticks === 1);
  await sleep(40);
  check("after the TTL: re-fetched", (await shortLived()) === 2);

  console.log("rejections are not cached:");
  let attempts = 0;
  const flaky = ttlCached(
    async () => {
      attempts++;
      if (attempts === 1) throw new Error("boom");
      return "ok";
    },
    { ttlMs: 60_000 },
  );
  let threw = false;
  try {
    await flaky();
  } catch {
    threw = true;
  }
  check("first call rejects", threw);
  check("second call retries and succeeds", (await flaky()) === "ok" && attempts === 2);
  check("…and that success IS cached", (await flaky()) === "ok" && attempts === 2);

  console.log("FIFO max:");
  let loads = 0;
  const bounded = ttlCached(async (k: string) => `${k}:${++loads}`, { ttlMs: 60_000, max: 2 });
  await bounded("a");
  await bounded("b");
  await bounded("c"); // evicts "a" (oldest)
  check("the newest keys stay cached", (await bounded("b")) === "b:2" && (await bounded("c")) === "c:3");
  check("the oldest key was evicted (re-loaded)", (await bounded("a")) === "a:4");

  console.log("tag purge:");
  let tagged = 0;
  let untagged = 0;
  const taggedFn = ttlCached(async () => ++tagged, { ttlMs: 60_000, tags: ["ztest:ttl"] });
  const untaggedFn = ttlCached(async () => ++untagged, { ttlMs: 60_000 });
  await taggedFn();
  await untaggedFn();
  clearTtlCache("ztest:ttl");
  check("clearTtlCache(tag) purges the tagged store", (await taggedFn()) === 2);
  check("…and leaves an untagged store alone", (await untaggedFn()) === 1);
  clearTtlCache();
  check("clearTtlCache() purges every store", (await untaggedFn()) === 2 && (await taggedFn()) === 3);

  console.log("TTL_CACHE_DISABLED escape hatch (read per call):");
  let direct = 0;
  const hatch = ttlCached(async () => ++direct, { ttlMs: 60_000 });
  process.env.TTL_CACHE_DISABLED = "1";
  await hatch();
  await hatch();
  check("with the flag every call reaches the source", direct === 2);
  delete process.env.TTL_CACHE_DISABLED;
  check("flag cleared: the next call fetches (bypassed calls never populated the cache)", (await hatch()) === 3);
  check("…and is cached again", (await hatch()) === 3);
  process.env.TTL_CACHE_DISABLED = "true";
  check("only the exact value \"1\" disables the cache", (await hatch()) === 3);
  delete process.env.TTL_CACHE_DISABLED;

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
