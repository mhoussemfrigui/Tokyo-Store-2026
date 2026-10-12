/**
 * Pure redirects helpers — path/destination/status normalizers + CSV parsing
 * for the admin redirects manager, the same-origin-aware loop walk, the off-site
 * status policy + owner gate (incl. an internal rule chaining into an off-site
 * one), the chain-reaches walk behind the slug checker's rename-back exception
 * and the source-coverage classifier — plus a source-order check that the admin
 * actions (form save, activation toggle, CSV import) apply that owner gate
 * BEFORE they write. No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/redirects.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  normalizeSourcePath,
  normalizeDestination,
  normalizeStatusCode,
  isPermanentStatus,
  parseRedirectsCsv,
  EXAMPLE_REDIRECTS_CSV,
  MAX_CSV_ROWS,
  ownHostsFrom,
  internalDestinationPath,
  isOffsiteDestination,
  effectiveStatusFor,
  redirectChainHasCycle,
  redirectChainReaches,
  redirectChainEndsOffsite,
  redirectWriteNeedsOwner,
  redirectSourceCoverage,
  redirectCoverageWarning,
} from "@/lib/redirects/normalize";

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

function main() {
  console.log("normalizeSourcePath:");
  check("null → null", normalizeSourcePath(null) === null);
  check("empty → null", normalizeSourcePath("  ") === null);
  check("no leading slash → null", normalizeSourcePath("old-page") === null);
  check("absolute URL → null", normalizeSourcePath("https://x.com/a") === null);
  check("simple path kept", normalizeSourcePath("/old-page") === "/old-page");
  check("trailing slash stripped", normalizeSourcePath("/old/") === "/old");
  check("root slash kept", normalizeSourcePath("/") === "/");
  check("query stripped", normalizeSourcePath("/old?utm=x") === "/old");
  check("hash stripped", normalizeSourcePath("/old#sec") === "/old");
  check("double slashes collapsed", normalizeSourcePath("//a///b") === "/a/b");
  check("internal whitespace → null", normalizeSourcePath("/a b") === null);

  console.log("normalizeDestination:");
  check("path kept", normalizeDestination("/new") === "/new");
  check("absolute http(s) kept", normalizeDestination("https://x.com/a") === "https://x.com/a");
  check("relative → null", normalizeDestination("new") === null);
  check("mailto → null", normalizeDestination("mailto:a@b.com") === null);
  check("javascript → null", normalizeDestination("javascript:alert(1)") === null);
  check("empty → null", normalizeDestination("") === null);

  console.log("normalizeStatusCode / isPermanentStatus:");
  check("301 kept", normalizeStatusCode("301") === 301);
  check("302 kept", normalizeStatusCode(302) === 302);
  check("307/308 kept", normalizeStatusCode("307") === 307 && normalizeStatusCode("308") === 308);
  check("invalid → 301", normalizeStatusCode("404") === 301);
  check("empty → 301", normalizeStatusCode(null) === 301);
  check("301/308 permanent", isPermanentStatus(301) && isPermanentStatus(308));
  check("302/307 temporary", !isPermanentStatus(302) && !isPermanentStatus(307));

  console.log("parseRedirectsCsv:");
  const basic = parseRedirectsCsv("source,destination,status\n/a,/b,301\n/c,/d,302");
  check("header skipped + 2 rows", basic.rows.length === 2 && basic.errors.length === 0);
  check(
    "rows parsed correctly",
    eq(basic.rows[0], { source: "/a", destination: "/b", status: 301 }) &&
      eq(basic.rows[1], { source: "/c", destination: "/d", status: 302 }),
  );
  const noStatus = parseRedirectsCsv("/a,/b");
  check("missing status → default 301", noStatus.rows[0]?.status === 301);
  const bad = parseRedirectsCsv("bad-source,/b\n/ok,notaurl\n/ok2,/dest");
  check("invalid source + dest reported as errors", bad.errors.length === 2 && bad.rows.length === 1);
  check("error carries line number", bad.errors[0]?.line === 1);
  const dup = parseRedirectsCsv("/a,/first,301\n/a,/second,302");
  check("dedupe by source (last wins)", dup.rows.length === 1 && dup.rows[0]?.destination === "/second");
  const loop = parseRedirectsCsv("/promo,/promo,301\n/ok,/dest,301");
  check("self-loop row rejected (source===destination)", loop.rows.length === 1 && loop.errors.length === 1 && loop.rows[0]?.source === "/ok");
  const quoted = parseRedirectsCsv('/a,"https://x.com/p,q",301');
  check("quoted field with comma kept", quoted.rows[0]?.destination === "https://x.com/p,q");
  check("null/empty → no rows", parseRedirectsCsv(null).rows.length === 0);

  const example = parseRedirectsCsv(EXAMPLE_REDIRECTS_CSV);
  check("example CSV parses cleanly (4 rows, 0 errors)", example.rows.length === 4 && example.errors.length === 0);
  const leadingBlank = parseRedirectsCsv("\n\nsource,destination,status\n/a,/b,301");
  check("header detected after leading blank lines", leadingBlank.rows.length === 1 && leadingBlank.errors.length === 0);
  const accentEncoded = parseRedirectsCsv("/caf%C3%A9,/cafe,301");
  check("pre-encoded source decoded on write", accentEncoded.rows[0]?.source === "/café");
  const trailingDest = parseRedirectsCsv("/a,/a/,301");
  check("trailing-slash dest self-loop caught", trailingDest.rows.length === 0 && trailingDest.errors.length === 1);
  const huge = parseRedirectsCsv(Array.from({ length: MAX_CSV_ROWS + 50 }, (_, i) => `/p${i},/d${i},301`).join("\n"));
  check(`CSV capped at MAX_CSV_ROWS (${MAX_CSV_ROWS}) with a truncation warning`, huge.rows.length === MAX_CSV_ROWS && huge.errors.some((e) => /Limite/.test(e.message)));

  // ── Same-origin vs off-site destinations (loop guard + off-site policy) ──
  console.log("own hosts / internal destination path:");
  const HOSTS = ownHostsFrom(["https://tokyostore.tn", "http://localhost:3000/", null, "", "not a url"]);
  check("own hosts: apex + www toggled", HOSTS.has("tokyostore.tn") && HOSTS.has("www.tokyostore.tn"));
  check("own hosts: port kept, garbage ignored", HOSTS.has("localhost:3000") && HOSTS.size === 4);
  check("www origin also yields the apex", ownHostsFrom(["https://www.shop.tn"]).has("shop.tn"));
  check("site path → normalized path", internalDestinationPath("/b/", HOSTS) === "/b");
  check("path query dropped (resolver matches the path only)", internalDestinationPath("/b?utm=x", HOSTS) === "/b");
  check("same-origin absolute → its path", internalDestinationPath("https://tokyostore.tn/a", HOSTS) === "/a");
  check("www same-origin absolute → its path", internalDestinationPath("https://WWW.tokyostore.tn/a/", HOSTS) === "/a");
  check("encoded same-origin path decoded", internalDestinationPath("https://tokyostore.tn/caf%C3%A9", HOSTS) === "/café");
  check("off-site absolute → null", internalDestinationPath("https://evil.example/a", HOSTS) === null);
  check("off-site detection", isOffsiteDestination("https://evil.example/a", HOSTS));
  check("own-host absolute is not off-site", !isOffsiteDestination("https://tokyostore.tn/a", HOSTS));
  check("a site path is not off-site", !isOffsiteDestination("/a", HOSTS));
  check("subdomain of the store counts as off-site", isOffsiteDestination("https://blog.tokyostore.tn/a", HOSTS));
  check("off-site permanent → 307", effectiveStatusFor("https://evil.example/a", 301, HOSTS) === 307 && effectiveStatusFor("https://evil.example/a", 308, HOSTS) === 307);
  check("off-site temporary kept", effectiveStatusFor("https://evil.example/a", 302, HOSTS) === 302);
  check("internal permanent kept", effectiveStatusFor("https://tokyostore.tn/a", 301, HOSTS) === 301 && effectiveStatusFor("/a", 308, HOSTS) === 308);

  console.log("redirectChainHasCycle:");
  const g = (pairs: Array<[string, string]>) => new Map(pairs);
  check("no edges → no cycle", !redirectChainHasCycle(g([]), "/a", HOSTS));
  check("A→B terminates", !redirectChainHasCycle(g([["/a", "/b"]]), "/a", HOSTS));
  check("A→B→A is a cycle", redirectChainHasCycle(g([["/a", "/b"], ["/b", "/a"]]), "/a", HOSTS));
  check("A → https://<store>/A is a cycle", redirectChainHasCycle(g([["/a", "https://tokyostore.tn/a"]]), "/a", HOSTS));
  check(
    "A → https://<store>/B + B → A is a cycle",
    redirectChainHasCycle(g([["/a", "https://www.tokyostore.tn/b"], ["/b", "/a"]]), "/a", HOSTS),
  );
  check("A → off-site terminates", !redirectChainHasCycle(g([["/a", "https://evil.example/a"]]), "/a", HOSTS));
  check("without own hosts an absolute URL still terminates (legacy behaviour)", !redirectChainHasCycle(g([["/a", "https://tokyostore.tn/a"]]), "/a"));
  check("A → A?x is a cycle", redirectChainHasCycle(g([["/a", "/a?x=1"]]), "/a", HOSTS));

  console.log("CSV self-loop through a same-origin URL:");
  const absLoop = parseRedirectsCsv("/a,https://tokyostore.tn/a,301\n/ok,/dest", HOSTS);
  check("same-origin absolute self-loop rejected", absLoop.rows.length === 1 && absLoop.errors.length === 1 && absLoop.rows[0]?.source === "/ok");
  const offKept = parseRedirectsCsv("/a,https://evil.example/a,301", HOSTS);
  check("off-site row with the same path is NOT a loop (policy is enforced by the action)", offKept.rows.length === 1);

  console.log("redirectChainReaches (slug checker's rename-back exception):");
  const own = (...p: string[]) => new Set(p);
  check("A→B reaches B", redirectChainReaches(g([["/a", "/b"]]), "/a", own("/b"), HOSTS));
  check("A→B→C reaches C", redirectChainReaches(g([["/a", "/b"], ["/b", "/c"]]), "/a", own("/c"), HOSTS));
  check("A→https://<store>/B reaches B", redirectChainReaches(g([["/a", "https://tokyostore.tn/b"]]), "/a", own("/b"), HOSTS));
  check("A→B does not reach C", !redirectChainReaches(g([["/a", "/b"]]), "/a", own("/c"), HOSTS));
  check("A→off-site does not reach anything", !redirectChainReaches(g([["/a", "https://evil.example/b"]]), "/a", own("/b"), HOSTS));
  check("a loop A→B→A terminates (false)", !redirectChainReaches(g([["/a", "/b"], ["/b", "/a"]]), "/a", own("/c"), HOSTS));
  check("no rule on the start → false", !redirectChainReaches(g([]), "/a", own("/a"), HOSTS));

  console.log("redirectChainEndsOffsite:");
  check("direct off-site → true", redirectChainEndsOffsite(g([["/a", "https://evil.example/"]]), "/a", HOSTS));
  check("internal hop into off-site → true", redirectChainEndsOffsite(g([["/a", "/b"], ["/b", "https://partner.tn"]]), "/a", HOSTS));
  check("same-origin absolute hop into off-site → true", redirectChainEndsOffsite(g([["/a", "https://tokyostore.tn/b"], ["/b", "https://partner.tn"]]), "/a", HOSTS));
  check("internal chain → false", !redirectChainEndsOffsite(g([["/a", "/b"], ["/b", "/c"]]), "/a", HOSTS));
  check("loop → false (no hang)", !redirectChainEndsOffsite(g([["/a", "/b"], ["/b", "/a"]]), "/a", HOSTS));

  console.log("redirectWriteNeedsOwner (off-site owner gate):");
  const ownerRule = { source: "/partenaire", destination: "https://partner.tn/", isActive: true };
  const active = g([["/partenaire", "https://partner.tn/"], ["/interne", "/montres"]]);
  const gate = (w: { source: string; destination: string; isActive: boolean }, prev: typeof ownerRule | null = null, edges = active) => {
    const rest = new Map(edges);
    if (prev) rest.delete(prev.source);
    return redirectWriteNeedsOwner({ ...w, prev, activeEdges: rest, ownHosts: HOSTS });
  };
  check("new off-site rule → owner", gate({ source: "/x", destination: "https://evil.example/", isActive: true }));
  check("new off-site rule saved INACTIVE → still owner", gate({ source: "/x", destination: "https://evil.example/", isActive: false }));
  check("notes-only edit of the owner's off-site rule (same source + destination) → open", !gate(ownerRule, ownerRule));
  check("deactivating the owner's off-site rule → open", !gate({ ...ownerRule, isActive: false }, ownerRule));
  check(
    "moving the owner's off-site rule onto another SOURCE → owner",
    gate({ source: "/rolex-submariner", destination: ownerRule.destination, isActive: true }, ownerRule),
  );
  check(
    "re-activating an inactive off-site rule → owner",
    gate({ ...ownerRule, isActive: true }, { ...ownerRule, isActive: false }),
  );
  check(
    "INTERNAL rule chaining into the owner's off-site rule → owner",
    gate({ source: "/rolex-submariner", destination: "/partenaire", isActive: true }),
  );
  check(
    "same-origin absolute rule chaining into it → owner",
    gate({ source: "/rolex-submariner", destination: "https://www.tokyostore.tn/partenaire", isActive: true }),
  );
  check(
    "chaining rule saved INACTIVE → open (the toggle re-checks on activation)",
    !gate({ source: "/rolex-submariner", destination: "/partenaire", isActive: false }),
  );
  check(
    "activation toggle of an inactive chaining rule → owner",
    gate(
      { source: "/rolex-submariner", destination: "/partenaire", isActive: true },
      { source: "/rolex-submariner", destination: "/partenaire", isActive: false },
    ),
  );
  check("purely internal rule → open", !gate({ source: "/ancienne", destination: "/interne", isActive: true }));

  console.log("redirectSourceCoverage:");
  check("/ → home", redirectSourceCoverage("/") === "home");
  check("flat retired slug → covered", redirectSourceCoverage("/ancienne-page") === "covered");
  check("/checkout (dedicated page) → static", redirectSourceCoverage("/checkout") === "static");
  check("/login → static", redirectSourceCoverage("/login") === "static");
  check("/robots.txt → static", redirectSourceCoverage("/robots.txt") === "static");
  check("/blog + /marques resolve their own URL → covered", redirectSourceCoverage("/blog") === "covered" && redirectSourceCoverage("/marques") === "covered");
  check("case-sensitive: /About reaches /[slug] → covered", redirectSourceCoverage("/About") === "covered");
  check("dynamic-only first segment alone (/u, /promo) → covered", redirectSourceCoverage("/u") === "covered" && redirectSourceCoverage("/promo") === "covered");
  check("/cat/sub → covered", redirectSourceCoverage("/ancienne-cat/ancienne-sous-cat") === "covered");
  check("/blog/x → covered", redirectSourceCoverage("/blog/x") === "covered");
  check("3+ segments (catch-all) → covered", redirectSourceCoverage("/product-category/hommes/montres") === "covered" && redirectSourceCoverage("/blog/2023/05/billet") === "covered");
  check("/account/orders/<id> (order detail) → app", redirectSourceCoverage("/account/orders/abc") === "app");
  check("/order/x, /order/verify/x, /admin/x/y, /api/x → app", ["/order/abc", "/order/verify/abc", "/admin/x/y", "/api/x"].every((p) => redirectSourceCoverage(p) === "app"));
  check("/login/2fa, /u/x, /facture/x, /feeds/x → app", ["/login/2fa", "/u/ali", "/facture/1", "/feeds/google.xml"].every((p) => redirectSourceCoverage(p) === "app"));
  check("/md/…, /cdn/… (catch-all handlers) → app", redirectSourceCoverage("/md/blog/x") === "app" && redirectSourceCoverage("/cdn/a/b/c.webp") === "app");
  check("legacy /category/x + /category/x/y (next.config 308) → app", redirectSourceCoverage("/category/montres") === "app" && redirectSourceCoverage("/category/montres/homme") === "app");
  check("legacy /product/x (next.config 308) → app", redirectSourceCoverage("/product/rolex") === "app");
  check("WooCommerce /product/<cat>/<slug> reaches the resolver → covered", redirectSourceCoverage("/product/montres/rolex-x") === "covered");
  check("deep /category/a/b/c reaches the catch-all → covered", redirectSourceCoverage("/category/a/b/c") === "covered");
  check(
    "/login/x, /pro/x, /account/x, /u/a/b, /order/a/b reach /[slug]/[sub] or the catch-all → covered",
    ["/login/x", "/pro/x", "/account/wishlist", "/account/orders", "/u/a/b", "/order/a/b"].every((p) => redirectSourceCoverage(p) === "covered"),
  );
  check("app → French warning", (redirectCoverageWarning("/order/abc") ?? "").includes("route applicative"));
  check("covered → no warning", redirectCoverageWarning("/ancienne-page") === null);
  check("static → French warning naming the path", /« \/checkout »/.test(redirectCoverageWarning("/checkout") ?? ""));
  check("home → warning", (redirectCoverageWarning("/") ?? "").includes("page d'accueil"));

  // ── Action wiring: the owner gate runs before every write (privilege escalation) ──
  console.log("actions/redirects.ts wiring (off-site owner gate):");
  const src = readFileSync(join(process.cwd(), "src", "lib", "actions", "redirects.ts"), "utf8");
  const body = (name: string) => {
    const start = src.indexOf(`export async function ${name}(`);
    const next = src.indexOf("\nexport async function ", start + 1);
    return start < 0 ? "" : src.slice(start, next < 0 ? undefined : next);
  };
  const save = body("saveRedirectAction");
  const gateAt = save.indexOf("redirectWriteNeedsOwner(");
  check(
    "save: gate (with the rule's previous source + destination) runs before the update and the create",
    gateAt > 0 &&
      /prev\s*\?\s*\{\s*source: prev\.source_path, destination: prev\.destination/.test(save) &&
      gateAt < save.indexOf("redirectService.update(") &&
      gateAt < save.indexOf("redirectService.create("),
  );
  check("save: a non-owner is refused with 'forbidden'", /holdsWildcard\(session\.user\.id\)[\s\S]{0,200}error: "forbidden"/.test(save.slice(gateAt)));
  const toggle = body("toggleRedirectAction");
  check(
    "toggle: activation goes through the same gate before setActive",
    toggle.indexOf("redirectWriteNeedsOwner(") > 0 && toggle.indexOf("redirectWriteNeedsOwner(") < toggle.indexOf("redirectService.setActive("),
  );
  const csvImport = body("importRedirectsCsvAction");
  check(
    "CSV: direct off-site rows AND rows chaining off-site are skipped for a non-owner before bulkUpsert",
    csvImport.indexOf("isOffsiteDestination(") > 0 &&
      csvImport.indexOf("redirectChainEndsOffsite(") > 0 &&
      /redirectChainEndsOffsite\([^)]*\) && !\(await isOwner\(\)\)/.test(csvImport) &&
      csvImport.indexOf("redirectChainEndsOffsite(") < csvImport.indexOf("redirectService.bulkUpsert("),
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
