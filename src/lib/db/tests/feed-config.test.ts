/**
 * Pure unit tests for the product-feed config normalizer. NO database.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/feed-config.test.ts
 */
import {
  resolveFeedConfig,
  normalizeFeedPath,
  normalizeIsoCountry,
  normalizeIsoCountryList,
  normalizeHttpsUrl,
  FEED_DEFAULTS,
} from "@/lib/seo/feeds/normalize";

let passed = 0;
let failed = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}

console.log("feed-config:");

const CTX = { origin: "https://tokyostore.tn", siteName: "Tokyo Store" };

// ── normalizeFeedPath
eq("path default when empty", normalizeFeedPath("", "google-merchant.xml"), "google-merchant.xml");
eq("path lowercased + cleaned", normalizeFeedPath("My Feed.XML", "f.xml"), "myfeed.xml");
eq("path with traversal/slashes → fallback (cleaned value starts with '.')", normalizeFeedPath("../../etc/passwd", "f.xml"), "f.xml");
eq("path strips slashes to a safe segment", normalizeFeedPath("sub/dir/feed.xml", "f.xml"), "subdirfeed.xml");
eq("path leading-dot → fallback", normalizeFeedPath(".hidden", "f.xml"), "f.xml");
eq("path '..' → fallback", normalizeFeedPath("..", "f.xml"), "f.xml");

// ── normalizeIsoCountry
eq("country upper", normalizeIsoCountry("tn", "XX"), "TN");
eq("country invalid → fallback", normalizeIsoCountry("tunisia", "TN"), "TN");
eq("country empty → fallback", normalizeIsoCountry("", "TN"), "TN");

// ── normalizeIsoCountryList
eq("country list parsed + deduped + upper", normalizeIsoCountryList("tn, FR ; tn", ["TN"]), ["TN", "FR"]);
eq("country list empty → fallback", normalizeIsoCountryList("", ["TN"]), ["TN"]);
eq("country list drops invalid", normalizeIsoCountryList("tn, usa, gb", ["TN"]), ["TN", "GB"]);

// ── normalizeHttpsUrl
eq("https kept", normalizeHttpsUrl("https://x.tn/p", "https://f"), "https://x.tn/p");
eq("http rejected → fallback", normalizeHttpsUrl("http://x.tn", "https://f"), "https://f");
eq("garbage → fallback", normalizeHttpsUrl("not a url", "https://f"), "https://f");
eq("empty → fallback", normalizeHttpsUrl("", "https://f"), "https://f");

// ── resolveFeedConfig defaults (empty map)
const def = resolveFeedConfig({}, CTX);
eq("feeds OFF by default", [def.google.enabled, def.acp.enabled], [false, false]);
eq("default google path", def.google.path, FEED_DEFAULTS.googlePath);
eq("default acp path", def.acp.path, FEED_DEFAULTS.acpPath);
eq("default store country TN", def.storeCountry, "TN");
eq("default target [TN]", def.targetCountries, ["TN"]);
eq("default return policy → /cgv", def.returnPolicyUrl, "https://tokyostore.tn/cgv");
eq("default privacy → /confidentialite", def.privacyUrl, "https://tokyostore.tn/confidentialite");
eq("default tos → /cgu", def.tosUrl, "https://tokyostore.tn/cgu");
eq("seller name from site name", def.sellerName, "Tokyo Store");
eq("seller url = origin", def.sellerUrl, "https://tokyostore.tn");

// ── resolveFeedConfig with overrides
const cfg = resolveFeedConfig(
  {
    "seo.feed_google_enabled": "true",
    "seo.feed_google_path": "merchant.xml",
    "seo.feed_acp_enabled": "1",
    "seo.feed_seller_name": "  Boutique GZ  ",
    "seo.feed_store_country": "fr",
    "seo.feed_target_countries": "fr, be, lu",
    "seo.feed_return_policy_url": "https://tokyostore.tn/retours",
  },
  CTX,
);
eq("google enabled + path", [cfg.google.enabled, cfg.google.path], [true, "merchant.xml"]);
eq("acp enabled via '1'", cfg.acp.enabled, true);
eq("seller name trimmed", cfg.sellerName, "Boutique GZ");
eq("store country override", cfg.storeCountry, "FR");
eq("target countries override", cfg.targetCountries, ["FR", "BE", "LU"]);
eq("return policy override", cfg.returnPolicyUrl, "https://tokyostore.tn/retours");
eq("trailing slash stripped from origin", resolveFeedConfig({}, { origin: "https://x.tn/", siteName: "S" }).sellerUrl, "https://x.tn");

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
