/**
 * Pure SEO settings normalizers — robots extra-disallow, sitemap extra URLs, and
 * the Organization @type allowlist that the admin SEO sub-tabs write. No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/seo-settings.test.ts
 */
import {
  normalizeOrgType,
  normalizeDisallowPaths,
  normalizeSitemapUrls,
  parseGeoCoord,
  MAX_ROBOTS_PATHS,
  MAX_SITEMAP_URLS,
} from "@/lib/seo/settings-normalize";

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
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const SITE = "https://tokyostore.tn";

function main() {
  console.log("normalizeOrgType:");
  check("default → Organization", normalizeOrgType(null) === "Organization");
  check("empty → Organization", normalizeOrgType("  ") === "Organization");
  check("OnlineStore kept", normalizeOrgType("OnlineStore") === "OnlineStore");
  check("Store kept", normalizeOrgType("Store") === "Store");
  check("unknown → Organization", normalizeOrgType("LocalBusiness") === "Organization");
  check("case-sensitive (onlinestore → default)", normalizeOrgType("onlinestore") === "Organization");

  console.log("normalizeDisallowPaths:");
  check("null → []", eq(normalizeDisallowPaths(null), []));
  check("single path", eq(normalizeDisallowPaths("/recherche"), ["/recherche"]));
  check(
    "newline + comma list",
    eq(normalizeDisallowPaths("/a\n/b, /c"), ["/a", "/b", "/c"]),
  );
  check("non-/ lines dropped", eq(normalizeDisallowPaths("recherche\n/ok"), ["/ok"]));
  check("absolute URL dropped", eq(normalizeDisallowPaths("https://x.com/a\n/ok"), ["/ok"]));
  check("internal whitespace stripped", eq(normalizeDisallowPaths("/a b"), ["/ab"]));
  check("dedupe", eq(normalizeDisallowPaths("/a\n/a"), ["/a"]));
  check(
    `capped at ${MAX_ROBOTS_PATHS}`,
    normalizeDisallowPaths(
      Array.from({ length: 80 }, (_, i) => `/p${i}`).join("\n"),
    ).length === MAX_ROBOTS_PATHS,
  );

  console.log("normalizeSitemapUrls:");
  check("null → []", eq(normalizeSitemapUrls(null, SITE), []));
  check(
    "path resolved against siteUrl",
    eq(normalizeSitemapUrls("/promo", SITE), ["https://tokyostore.tn/promo"]),
  );
  check(
    "absolute http(s) kept",
    eq(normalizeSitemapUrls("https://x.com/a", SITE), ["https://x.com/a"]),
  );
  check("mailto/relative/garbage dropped", eq(normalizeSitemapUrls("mailto:a@b.com\nfoo\n/ok", SITE), ["https://tokyostore.tn/ok"]));
  check(
    "mixed newline + comma",
    eq(normalizeSitemapUrls("/a, /b", SITE), ["https://tokyostore.tn/a", "https://tokyostore.tn/b"]),
  );
  check("dedupe", eq(normalizeSitemapUrls("/a\n/a", SITE), ["https://tokyostore.tn/a"]));
  check("path with empty siteUrl dropped", eq(normalizeSitemapUrls("/a", ""), []));
  check(
    `capped at ${MAX_SITEMAP_URLS}`,
    normalizeSitemapUrls(
      Array.from({ length: 150 }, (_, i) => `/p${i}`).join("\n"),
      SITE,
    ).length === MAX_SITEMAP_URLS,
  );

  console.log("parseGeoCoord (LocalBusiness geo):");
  check("blank → null", parseGeoCoord("  ", 90) === null);
  check("null → null", parseGeoCoord(null, 90) === null);
  check("valid latitude parsed", parseGeoCoord("34.7406", 90) === 34.7406);
  check("valid negative longitude parsed", parseGeoCoord("-10.76", 180) === -10.76);
  check("integer string parsed", parseGeoCoord("0", 90) === 0);
  check("latitude out of ±90 → null", parseGeoCoord("91", 90) === null);
  check("longitude in range (120) with max 180 kept", parseGeoCoord("120", 180) === 120);
  check("120 rejected as a latitude (max 90)", parseGeoCoord("120", 90) === null);
  check("non-numeric → null", parseGeoCoord("abc", 90) === null);
  check("trailing junk → null (not partial parse)", parseGeoCoord("34.74x", 90) === null);
  check("Infinity → null", parseGeoCoord("Infinity", 90) === null);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
