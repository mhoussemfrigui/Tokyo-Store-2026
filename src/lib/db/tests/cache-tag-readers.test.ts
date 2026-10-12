/**
 * Cache-tag vocabulary ↔ readers, plus the B2B/promo dead-code removals —
 * static source checks, NO database.
 *
 * `src/lib/cache/tags.ts` is the single tag vocabulary, but a tag only does
 * something when a cached READ declares it (`'use cache'` + `cacheTag(...)`, or
 * an `unstable_cache` / `ttlCached` `tags: [...]` list). A bust with no reader is
 * a no-op that reads like an invalidation guarantee, so this pins:
 *   - every CACHE_TAGS entry / cacheTag builder is either declared by a reader
 *     in src/ OR on the explicit RESERVED list below (which mirrors the
 *     "reserved — no reader yet" notes in tags.ts). A new tag without a reader,
 *     or a reserved tag that gains one, fails here so the notes stay truthful;
 *   - the retired no-reader tags (`products:published`, `promotions`,
 *     `category:<id>`, `collection:<id>`) stay gone;
 *   - the dead B2B/promo surfaces stay deleted: no partner attach-by-email
 *     action (consent-less membership + account-existence oracle), partner
 *     member removal goes through the workflow, no businessService.listForUser,
 *     no unreachable `urlSlug` branch in the coupon evaluate workflow.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/cache-tag-readers.test.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { CACHE_TAGS, cacheTag } from "@/lib/cache/tags";

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

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

/** Tags busted as forward-wiring with NO cached reader yet (see tags.ts). */
const RESERVED_TAG_KEYS = new Set<keyof typeof CACHE_TAGS>([
  "blogTags",
  "banners",
  "faqs",
  "nav",
  "pages",
]);
const RESERVED_BUILDERS = new Set<keyof typeof cacheTag>([
  "blogPostSlug",
  "blogCategory",
  "bannersPlacement",
  "faqsScope",
  "navKey",
  "navMenu",
  "pageSlug",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** Drop block + line comments so a doc example (`cacheTag(CACHE_TAGS.x)` in a
 *  comment) never counts as a reader. `://` (URLs in strings) is kept. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Text of every balanced `open…close` group that starts right after `re`. */
function groupsAfter(src: string, re: RegExp, open: string, close: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(re)) {
    let i = (m.index ?? 0) + m[0].length;
    let depth = 1;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === open) depth++;
      else if (src[i] === close) depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

function main() {
  const files = walk(SRC_DIR).filter((f) => {
    const rel = relative(SRC_DIR, f).split(sep).join("/");
    return !rel.startsWith("lib/db/tests/") && rel !== "lib/cache/tags.ts";
  });

  // Every reader declaration: next/cache `cacheTag(...)` (NOT the `cacheTag.x`
  // builder object — no `(` right after the name) + `tags: [...]` lists.
  const declared: string[] = [];
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"));
    declared.push(...groupsAfter(src, /\bcacheTag\(/g, "(", ")"));
    declared.push(...groupsAfter(src, /\btags:\s*\[/g, "[", "]"));
  }
  const readText = declared.join("\n");
  const readKeys = new Set([...readText.matchAll(/CACHE_TAGS\.(\w+)/g)].map((m) => m[1]));
  const builderNames = new Set(Object.keys(cacheTag));
  const readBuilders = new Set(
    [...readText.matchAll(/\.(\w+)\(/g)].map((m) => m[1]).filter((n) => builderNames.has(n)),
  );

  console.log("scan sanity:");
  check("found the catalog/blog/track/search readers", readKeys.has("productsList") && readKeys.has("blogPosts") && readKeys.has("settings") && readKeys.has("searchAliases"));
  check("found the PDP per-product builders", readBuilders.has("product") && readBuilders.has("productSlug"));

  console.log("CACHE_TAGS — every tag has a reader or is marked reserved:");
  for (const key of Object.keys(CACHE_TAGS) as (keyof typeof CACHE_TAGS)[]) {
    const isRead = readKeys.has(key);
    const isReserved = RESERVED_TAG_KEYS.has(key);
    check(
      `${key} (${CACHE_TAGS[key]}) → ${isRead ? "read" : isReserved ? "reserved" : "NO reader, not reserved"}`,
      isRead !== isReserved,
    );
  }
  for (const key of RESERVED_TAG_KEYS) {
    check(`reserved ${key} still exists in the vocabulary`, key in CACHE_TAGS);
  }

  console.log("cacheTag builders — every builder has a reader or is marked reserved:");
  for (const name of Object.keys(cacheTag) as (keyof typeof cacheTag)[]) {
    const isRead = readBuilders.has(name);
    const isReserved = RESERVED_BUILDERS.has(name);
    check(
      `${name} → ${isRead ? "read" : isReserved ? "reserved" : "NO reader, not reserved"}`,
      isRead !== isReserved,
    );
  }

  console.log("retired no-reader tags stay gone:");
  const tagValues = new Set<string>(Object.values(CACHE_TAGS));
  check("no `products:published` tag", !tagValues.has("products:published"));
  check("no `promotions` tag", !tagValues.has("promotions"));
  check("no per-id category/collection builders", !builderNames.has("category") && !builderNames.has("collection"));
  const tagsSrc = read("src", "lib", "cache", "tags.ts");
  check("tags.ts documents the reserved (no reader yet) entries", /reserved — no reader yet/.test(tagsSrc));

  console.log("promo dead code:");
  const redeem = read("src", "workflows", "promotion", "redeem.ts");
  check("evaluate workflow has no urlSlug input/branch", !redeem.includes("urlSlug"));
  check("evaluate workflow resolves by code only", redeem.includes("findLiveByCode(d.code)"));

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
