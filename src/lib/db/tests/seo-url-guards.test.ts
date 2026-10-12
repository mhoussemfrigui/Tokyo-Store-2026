/**
 * Pure SEO URL guards (lib/seo/url-guards.ts). NO DB.
 *
 *   - hasForeignCanonical: the sitemap skips a product / brand whose canonical
 *     override points AWAY from its own URL (a duplicate folded onto a master);
 *   - validateSiteUrlInput: a `seo.site_url` change must be a bare https origin
 *     (http only for localhost) — it is the origin of payment return URLs, email
 *     links, invite links and printed QR codes;
 *   - siteUrlChangeRefused / isSiteUrlChange: only the owner (`*`) may change it;
 *     a delegate's disabled field (not posted) keeps the stored value;
 *   - wiring (source order): saveSeoSettingsAction resolves the caller's `*`,
 *     refuses a delegate's change BEFORE validating / writing any setting.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/seo-url-guards.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  hasForeignCanonical,
  isSiteUrlChange,
  siteUrlChangeRefused,
  validateSiteUrlInput,
} from "@/lib/seo/url-guards";

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

const SELF = "https://tokyostore.tn/submariner";

function main() {
  console.log("hasForeignCanonical:");
  check("no override → self-canonical", !hasForeignCanonical(null, SELF) && !hasForeignCanonical("  ", SELF));
  check("override = own URL → self-canonical", !hasForeignCanonical(SELF, SELF));
  check("trailing slash ignored", !hasForeignCanonical(`${SELF}/`, SELF));
  check("host case ignored", !hasForeignCanonical("https://TokyoStore.tn/submariner", SELF));
  check("site-relative own path → self-canonical", !hasForeignCanonical("/submariner", SELF));
  check("another product's URL → foreign", hasForeignCanonical("https://tokyostore.tn/submariner-date", SELF));
  check("site-relative other path → foreign", hasForeignCanonical("/rolex", SELF));
  check("another domain → foreign", hasForeignCanonical("https://other.tn/submariner", SELF));
  check("www vs apex is another URL → foreign", hasForeignCanonical("https://www.tokyostore.tn/submariner", SELF));
  check("a query makes it another URL → foreign", hasForeignCanonical(`${SELF}?ref=1`, SELF));
  check("unparseable self URL → left alone", !hasForeignCanonical("/x", "not a url"));

  console.log("validateSiteUrlInput:");
  const ok = (raw: string, want: string) => {
    const r = validateSiteUrlInput(raw);
    return r.ok && r.value === want;
  };
  const bad = (raw: string) => !validateSiteUrlInput(raw).ok;
  check("empty → allowed (falls back to the env origin)", ok("  ", ""));
  check("https origin kept", ok("https://tokyostore.tn", "https://tokyostore.tn"));
  check("trailing slash normalized away", ok("https://tokyostore.tn/", "https://tokyostore.tn"));
  check("host lower-cased, port kept", ok("https://Shop.TN:8443", "https://shop.tn:8443"));
  check("http refused for a public host", bad("http://tokyostore.tn"));
  check("http allowed for localhost", ok("http://localhost:3000", "http://localhost:3000"));
  check("http allowed for 127.0.0.1", ok("http://127.0.0.1:3000/", "http://127.0.0.1:3000"));
  check("a path is refused", bad("https://tokyostore.tn/shop"));
  check("a query is refused", bad("https://tokyostore.tn/?x=1"));
  check("a fragment is refused", bad("https://tokyostore.tn/#x"));
  check("credentials are refused", bad("https://user:pw@tokyostore.tn"));
  check("non-http scheme refused", bad("javascript:alert(1)") && bad("ftp://tokyostore.tn"));
  check("garbage refused", bad("tokyostore.tn"));
  const msg = validateSiteUrlInput("http://tokyostore.tn");
  check("French message on refusal", !msg.ok && /https/.test(msg.message));

  console.log("siteUrlChangeRefused / isSiteUrlChange:");
  const STORED = "https://tokyostore.tn";
  check("not posted (delegate's disabled field) → no change", !isSiteUrlChange(null, STORED));
  check("same value (trailing slash) → no change", !isSiteUrlChange("https://tokyostore.tn/", STORED));
  check("different value → change", isSiteUrlChange("https://attacker.tld", STORED));
  check("clearing a stored value is a change", isSiteUrlChange("", STORED));
  check("delegate: not posted → kept, not refused", !siteUrlChangeRefused(false, null, STORED));
  check("delegate: identical post → harmless", !siteUrlChangeRefused(false, STORED, STORED));
  check("delegate: repointing → REFUSED", siteUrlChangeRefused(false, "https://attacker.tld", STORED));
  check("delegate: clearing → REFUSED", siteUrlChangeRefused(false, "", STORED));
  check("owner: repointing allowed", !siteUrlChangeRefused(true, "https://new-domain.tn", STORED));
  check("delegate: first set on an empty store → REFUSED too", siteUrlChangeRefused(false, "https://x.tn", ""));

  console.log("saveSeoSettingsAction wiring (owner gate before any write):");
  const src = readFileSync(join(process.cwd(), "src", "lib", "actions", "seo.ts"), "utf8");
  const start = src.indexOf("export async function saveSeoSettingsAction(");
  const next = src.indexOf("\nexport async function ", start + 1);
  const action = start < 0 ? "" : src.slice(start, next < 0 ? undefined : next);
  const ownerAt = action.indexOf(".has(WILDCARD)");
  const refuseAt = action.indexOf("siteUrlChangeRefused(isOwner, postedSiteUrl, storedSiteUrl)");
  check("the caller's `*` is resolved from their own permissions", ownerAt > 0 && /resolveUserPermissions\(session\.user\.id\)/.test(action));
  check("the refusal returns 'forbidden'", refuseAt > ownerAt && /error: "forbidden"/.test(action.slice(refuseAt, refuseAt + 400)));
  check(
    "the gate runs before the site-URL validation and before any setting write",
    refuseAt > 0 &&
      refuseAt < action.indexOf("validateSiteUrlInput(") &&
      refuseAt < action.indexOf("for (const f of TEXT_FIELDS)"),
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
