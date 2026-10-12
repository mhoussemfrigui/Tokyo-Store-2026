/**
 * Reserved-route drift guard — PURE (no DB). The slug checker refuses entity /
 * CMS slugs that a file route owns (a file route always wins over the dynamic
 * `(shop)/[slug]` resolver, so a colliding category / brand / product / page
 * would be unreachable), and the admin redirects manager flags rules on those
 * URLs as never firing. Both read lib/pages/reserved-routes.ts — this test diffs
 * it against the REAL `src/app` tree so a new route can't silently drift:
 *
 *   1. every first-level route directory — at the app root AND inside every
 *      route group (`(shop)`, `(documents)`…) — is a reserved slug;
 *   2. every such directory that serves its OWN URL (`page.tsx` / `route.ts`)
 *      is in STATIC_SINGLE_SEGMENT_ROUTES, and every entry there exists on disk
 *      (or is a metadata file route) — no stale names;
 *   3. the metadata file routes (sitemap.ts, manifest.ts, icon.svg) are reserved;
 *   4. vitrine slugs + a custom single-segment ADMIN_LOGIN_PATH are reserved;
 *   5. redirect coverage: every MULTI-segment file route outside admin / api that
 *      doesn't call resolveRedirect is an APP_ROUTE_SHAPES match (`app`), and
 *      every one that does is `covered` — so the « Jamais appliquée » warning
 *      tracks the real tree.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/reserved-routes.test.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { COLLECTION_SLUGS } from "@/lib/pages/collection-slugs";
import { redirectSourceCoverage } from "@/lib/redirects/normalize";
import {
  APP_ROUTE_SHAPES,
  REDIRECT_AWARE_STATIC_ROUTES,
  RESERVED_ROUTES,
  STATIC_SINGLE_SEGMENT_ROUTES,
  adminLoginSlug,
  isReservedSlug,
} from "@/lib/pages/reserved-routes";

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

const APP_DIR = join(process.cwd(), "src", "app");

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
/** A directory serving its OWN URL (not only dynamic children). */
const servesOwnUrl = (dir: string) =>
  ["page.tsx", "page.ts", "route.ts", "route.tsx"].some((f) => existsSync(join(dir, f)));

/** Route-group roots: the app root + every `(group)` dir, collected transitively
 *  so NESTED groups count too — storefront routes now live under `(shop)/(shell)`
 *  (the chrome layer below the 404 boundary), not directly under `(shop)`. */
function groupRoots(dir: string): string[] {
  const nested = readdirSync(dir)
    .filter((d) => d.startsWith("(") && isDir(join(dir, d)))
    .flatMap((d) => groupRoots(join(dir, d)));
  return [dir, ...nested];
}
const roots = groupRoots(APP_DIR);

/** First-level route directories: not dynamic `[x]`, not a group `(x)`, not private `_x`. */
const firstLevel: Array<{ name: string; dir: string }> = [];
for (const root of roots) {
  for (const d of readdirSync(root)) {
    const dir = join(root, d);
    if (!isDir(dir) || d.startsWith("[") || d.startsWith("(") || d.startsWith("_")) continue;
    firstLevel.push({ name: d, dir });
  }
}

/** Metadata FILE routes (no directory) at the app root → the URL name they serve. */
const METADATA_FILES: Record<string, string> = {
  "sitemap.ts": "sitemap.xml",
  "manifest.ts": "manifest.webmanifest",
  "robots.ts": "robots.txt",
  "icon.svg": "icon.svg",
  "favicon.ico": "favicon.ico",
};

/**
 * Every file route with 2+ URL segments outside `/admin` and `/api` (both
 * wholesale APP_ROUTE_SHAPES), as a sample URL (`[x]` → `x`, a catch-all →
 * `x/y`, route groups dropped) + whether its file consults the redirect table.
 */
function multiSegmentRoutes(): Array<{ sample: string; aware: boolean }> {
  const out: Array<{ sample: string; aware: boolean }> = [];
  const walk = (dir: string, segs: string[]) => {
    for (const f of ["page.tsx", "page.ts", "route.ts", "route.tsx"]) {
      const file = join(dir, f);
      if (segs.length >= 2 && existsSync(file)) {
        out.push({ sample: `/${segs.join("/")}`, aware: readFileSync(file, "utf8").includes("resolveRedirect(") });
      }
    }
    for (const d of readdirSync(dir)) {
      const sub = join(dir, d);
      if (!isDir(sub) || d.startsWith("_")) continue;
      if (segs.length === 0 && (d === "admin" || d === "api")) continue;
      if (d.startsWith("(")) walk(sub, segs);
      else if (d.startsWith("[...") || d.startsWith("[[...")) walk(sub, [...segs, "x", "y"]);
      else if (d.startsWith("[")) walk(sub, [...segs, "x"]);
      else walk(sub, [...segs, d]);
    }
  };
  walk(APP_DIR, []);
  return out;
}

function main() {
  console.log("1. every first-level route directory is reserved:");
  check(`found the route tree (${firstLevel.length} first-level dirs)`, firstLevel.length > 20);
  const unreserved = firstLevel.filter((r) => !RESERVED_ROUTES.has(r.name)).map((r) => r.name);
  check(
    `all reserved${unreserved.length ? ` (missing: ${unreserved.join(", ")})` : ""}`,
    unreserved.length === 0,
  );

  console.log("2. STATIC_SINGLE_SEGMENT_ROUTES matches the dirs serving their own URL:");
  const ownUrl = firstLevel.filter((r) => servesOwnUrl(r.dir)).map((r) => r.name);
  const missingStatic = ownUrl.filter((n) => !STATIC_SINGLE_SEGMENT_ROUTES.has(n));
  check(
    `every page.tsx/route.ts dir listed${missingStatic.length ? ` (missing: ${missingStatic.join(", ")})` : ""}`,
    missingStatic.length === 0,
  );
  const metadataNames = new Set(Object.values(METADATA_FILES));
  const stale = [...STATIC_SINGLE_SEGMENT_ROUTES].filter(
    (n) => !ownUrl.includes(n) && !metadataNames.has(n),
  );
  check(`no stale static entry${stale.length ? ` (stale: ${stale.join(", ")})` : ""}`, stale.length === 0);
  // A name that serves its own URL in ANY route group is static — even if a
  // SIBLING group holds only its dynamic children. The storefront swap split
  // several namespaces this way: `/account` is served by `(tokyo)/account/page.tsx`
  // while `(shell)/account/` holds just `orders/[id]` (same for checkout / favoris
  // / panier). Dedupe against `ownUrl` so that split isn't mis-flagged as a
  // dynamic-only dir wrongly listed in STATIC_SINGLE_SEGMENT_ROUTES.
  const dynamicOnly = firstLevel
    .filter((r) => !servesOwnUrl(r.dir))
    .map((r) => r.name)
    .filter((n) => !ownUrl.includes(n));
  check(
    `dynamic-only dirs (${dynamicOnly.join(", ")}) are NOT static single-segment routes`,
    dynamicOnly.every((n) => !STATIC_SINGLE_SEGMENT_ROUTES.has(n)),
  );
  check(
    "every static single-segment route is reserved",
    [...STATIC_SINGLE_SEGMENT_ROUTES].every((n) => RESERVED_ROUTES.has(n)),
  );
  check(
    "redirect-aware static routes are static single-segment routes",
    [...REDIRECT_AWARE_STATIC_ROUTES].every((n) => STATIC_SINGLE_SEGMENT_ROUTES.has(n)),
  );
  check(
    "every app-route shape starts with a reserved first segment",
    APP_ROUTE_SHAPES.every((shape) => RESERVED_ROUTES.has(shape.split("/")[0]!)),
  );

  console.log("3. metadata file routes are reserved:");
  for (const [file, url] of Object.entries(METADATA_FILES)) {
    if (existsSync(join(APP_DIR, file))) check(`${file} → ${url} reserved`, RESERVED_ROUTES.has(url));
  }

  console.log("4. vitrine slugs + custom admin-login path:");
  check("every COLLECTION_SLUGS entry reserved", COLLECTION_SLUGS.every((s) => RESERVED_ROUTES.has(s)));
  check("the storefront routes the audit found missing are reserved", [
    "favoris", "se-desabonner",
    // The old dedicated content routes (carrieres / nos-boutiques / notre-histoire
    // / service-client) are gone — they are now editable CMS system pages served by
    // `(tokyo)/[slug]`. Their replacement CMS slugs are reserved via CMS_SYSTEM_PAGE_SLUGS.
    "apropos", "aide", "recrutement", "mentions", "confidentialite", "admin-login",
    "promo", "u", "feeds", "md", "facture",
  ].every((s) => RESERVED_ROUTES.has(s)));
  check(
    "default admin-login path → `admin-login` (already a reserved route)",
    adminLoginSlug("/admin-login") === "admin-login" && RESERVED_ROUTES.has("admin-login"),
  );
  check("custom single-segment secret path → reserved", isReservedSlug("staff-x7k2", "/staff-x7k2"));
  check("custom path is lower-cased", isReservedSlug("staff-x7k2", "/Staff-X7K2"));
  check("multi-segment secret path → its first segment stays free", !isReservedSlug("staff", "/staff/x7k2"));
  check("a normal slug is free", !isReservedSlug("montres-homme", "/admin-login"));

  console.log("5. redirect coverage matches the multi-segment file routes:");
  const multi = multiSegmentRoutes();
  check(`found the multi-segment routes (${multi.length})`, multi.length > 10);
  const wrong = multi.filter((r) => redirectSourceCoverage(r.sample) !== (r.aware ? "covered" : "app"));
  check(
    `redirect-aware → covered, others → app${
      wrong.length ? ` (wrong: ${wrong.map((r) => `${r.sample}=${redirectSourceCoverage(r.sample)}`).join(", ")})` : ""
    }`,
    wrong.length === 0,
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
