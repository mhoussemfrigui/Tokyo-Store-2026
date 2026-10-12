/**
 * Storefront chrome & home invariants — NO database, NO network:
 *
 *  1. Dark-mode pre-paint script (buildDarkModeInitJs): admin « Désactivé
 *     (clair uniquement) » forces light even over a saved "dark" (the toggle is
 *     hidden in that mode, so the visitor had no way back); otherwise the saved
 *     choice wins, then the admin default / OS preference. The toggle writes the
 *     same storage key the script reads.
 *  2. Menu dead-link pruning (pruneDeadNavItems): an item pointing at a
 *     deactivated / deleted category or brand is dropped with its
 *     sub-items; a manual href wins over the ref; other kinds are untouched; an
 *     unknown live set (null) keeps every link; a dead ref an active redirect
 *     still serves (renamed slug) is re-admitted (listDeadNavItems +
 *     admitNavRefs) and kept; the admin menu rows flag the dropped links.
 *  3. Home CTA fallbacks (HOME_DEFAULTS) and the 404 « Explorer la boutique »
 *     link point at routes that exist (they used to 404: /produits,
 *     /a-propos, /boutique).
 *  4. Wiring guards (file scans): header `main` items carry icon + new tab, the
 *     manifest is not prerendered, the home best-sellers rail uses the sales
 *     ranking (no Nouveautés fallback) and drops the unused brand/category
 *     fetch, the link picker offers only storefront-visible categories.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/storefront-chrome.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { buildDarkModeInitJs, DARK_MODE_STORAGE_KEY } from "@/lib/theme/dark-mode-init";
import {
  admitNavRefs,
  checkedNavKind,
  hasCheckedNavRef,
  listDeadNavItems,
  pruneDeadNavItems,
  type LiveNavTargets,
} from "@/lib/cms/nav-link-liveness";
import { HOME_DEFAULTS } from "@/lib/pages/home-config-defaults";
import { isCollectionSlug } from "@/lib/pages/collection-slugs";
import { CMS_SYSTEM_PAGE_SLUGS } from "@/lib/pages/reserved-routes";

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
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * Run the init script against fake browser globals. Returns the `force` value
 * passed to classList.toggle("dark", …), or null when it never ran (storage
 * blocked ⇒ the catch keeps the server-rendered light default).
 */
function runInit(
  mode: "off" | "system" | "on",
  stored: string | null,
  prefersDark: boolean,
  opts: { storageThrows?: boolean } = {},
): boolean | null {
  let dark: boolean | null = null;
  const storage = {
    getItem: (key: string) => {
      if (opts.storageThrows) throw new Error("SecurityError");
      return key === DARK_MODE_STORAGE_KEY ? stored : null;
    },
  };
  const win = {
    matchMedia: (q: string) => ({ matches: prefersDark && q.includes("dark") }),
  };
  const doc = {
    documentElement: {
      classList: {
        toggle: (cls: string, force: boolean) => {
          if (cls === "dark") dark = force;
        },
      },
    },
  };
  new Function("localStorage", "window", "document", buildDarkModeInitJs(mode))(
    storage,
    win,
    doc,
  );
  return dark;
}

/** A storefront path resolves when it is "/", a showcase page, an editable CMS
 *  system page (served by the `(shop)/(tokyo)/[slug]` resolver, so no own route
 *  folder on disk — e.g. /aide, /apropos), or a route folder under either
 *  storefront route group — most chrome pages live under `(shop)/(shell)`, the
 *  rest under `(shop)/(tokyo)` (which also holds the home `page.tsx`); `(shop)`
 *  itself holds only the thin layout + 404. */
function isStorefrontRoute(href: string): boolean {
  if (href === "/") return true;
  const seg = href.replace(/^\//, "").split(/[/?#]/)[0];
  if (!seg) return false;
  if (isCollectionSlug(seg)) return true;
  if (CMS_SYSTEM_PAGE_SLUGS.has(seg)) return true;
  return (
    existsSync(join(ROOT, "src", "app", "(shop)", "(shell)", seg, "page.tsx")) ||
    existsSync(join(ROOT, "src", "app", "(shop)", "(tokyo)", seg, "page.tsx"))
  );
}

type Node = {
  label: string;
  href: string | null;
  internal_kind: string | null;
  internal_ref: string | null;
  children: Node[];
};
const node = (
  label: string,
  target: { href?: string; kind?: string; ref?: string },
  children: Node[] = [],
): Node => ({
  label,
  href: target.href ?? null,
  internal_kind: target.kind ?? null,
  internal_ref: target.ref ?? null,
  children,
});

function main() {
  // ── 1. Dark mode ────────────────────────────────────────────────────────
  console.log("dark-mode init script:");
  check("admin off + saved dark ⇒ LIGHT (no stranded visitor)", runInit("off", "dark", true) === false);
  check("admin off + nothing saved ⇒ light", runInit("off", null, true) === false);
  check("admin on + saved light ⇒ light (visitor choice wins)", runInit("on", "light", false) === false);
  check("admin on + nothing saved ⇒ dark", runInit("on", null, false) === true);
  check("admin system + saved dark ⇒ dark", runInit("system", "dark", false) === true);
  check("admin system + OS dark ⇒ dark", runInit("system", null, true) === true);
  check("admin system + OS light ⇒ light", runInit("system", null, false) === false);
  check(
    "storage blocked ⇒ script swallows the error (stays light)",
    runInit("on", null, false, { storageThrows: true }) === null,
  );
  check(
    "mode is JSON-embedded (validated enum, injection-safe)",
    buildDarkModeInitJs("system").includes('var m="system"'),
  );
  const toggleSrc = read("src/components/storefront/dark-mode-toggle.tsx");
  check(
    "toggle persists under the key the script reads",
    toggleSrc.includes("DARK_MODE_STORAGE_KEY") && !toggleSrc.includes('"gz-theme"'),
  );
  check(
    "shop layout builds its init script from the shared helper",
    read("src/app/(shop)/(shell)/layout.tsx").includes("buildDarkModeInitJs(darkMode)"),
  );
  check(
    "tokyo (live) layout builds its init script from the shared helper",
    read("src/app/(shop)/(tokyo)/layout.tsx").includes("buildDarkModeInitJs(darkMode)"),
  );

  // ── 2. Menu dead-link pruning ───────────────────────────────────────────
  console.log("menu dead-link pruning:");
  const live: LiveNavTargets = {
    category: new Set(["homme", "femme"]),
    brand: new Set(["rolex"]),
    page: new Set(["a-propos"]),
    // VISIBLE showcase slugs (Catalogues → pages.<slug>.visible). "top-ventes"
    // is intentionally absent → its nav link is a dead ref (hidden showcase).
    system: new Set(["nouveautes"]),
  };
  const tree: Node[] = [
    node("Homme", { kind: "category", ref: "homme" }),
    node("Bracelets", { kind: "category", ref: "bracelets" }, [
      node("Cuir", { kind: "category", ref: "femme" }),
    ]),
    node("Rolex", { kind: "brand", ref: "rolex" }),
    node("Omega", { kind: "brand", ref: "omega" }),
    node("Manuel", { href: "/bracelets", kind: "category", ref: "bracelets" }),
    node("Nouveautés", { kind: "system", ref: "nouveautes" }),
    node("À propos", { kind: "page", ref: "a-propos" }),
    node("Page supprimée", { kind: "page", ref: "introuvable" }),
    node("Groupe", { href: "/help" }, [
      node("Montres", { kind: "category", ref: "homme" }),
      node("Ancienne", { kind: "category", ref: "retiree" }),
    ]),
    node("Top ventes cachée", { kind: "system", ref: "top-ventes" }),
  ];
  const pruned = pruneDeadNavItems(tree, live);
  const labels = pruned.map((n) => n.label);
  check("live category kept", labels.includes("Homme"));
  check("dead category dropped WITH its sub-items", !labels.includes("Bracelets") && !labels.includes("Cuir"));
  check("live brand kept, dead brand dropped", labels.includes("Rolex") && !labels.includes("Omega"));
  check("a manual href wins over a dead ref (kept)", labels.includes("Manuel"));
  check(
    "live showcase (system) kept, hidden showcase dropped",
    labels.includes("Nouveautés") && !labels.includes("Top ventes cachée"),
  );
  check("live CMS page kept, dead CMS page dropped", labels.includes("À propos") && !labels.includes("Page supprimée"));
  const group = pruned.find((n) => n.label === "Groupe");
  check(
    "dead sub-item pruned under a live parent",
    group !== undefined && group.children.map((c) => c.label).join() === "Montres",
  );
  check("input tree is not mutated", tree[8].children.length === 2);
  check("unknown live set (null) keeps every link", pruneDeadNavItems(tree, null).length === tree.length);
  check("checkedNavKind: manual href ⇒ null", checkedNavKind(tree[4]) === null);
  check("checkedNavKind: brand ref ⇒ brand", checkedNavKind(tree[2]) === "brand");
  check("checkedNavKind: system (showcase) ref ⇒ system", checkedNavKind(tree[5]) === "system");
  check("hasCheckedNavRef finds a nested ref", hasCheckedNavRef([node("G", { href: "/x" }, [tree[0]])]));
  check("hasCheckedNavRef finds a system ref", hasCheckedNavRef([tree[5]]));
  check(
    "hasCheckedNavRef false for manual-only links (no lookup needed)",
    !hasCheckedNavRef([tree[4], node("x", { href: "/help" })]),
  );
  // A renamed slug (rename 301) or an operator redirect keeps the stored URL
  // working: the caller re-admits such refs before pruning.
  const dead = listDeadNavItems(tree, live).map((n) => n.label);
  check(
    "listDeadNavItems: every dead checked ref, at any depth (incl. under a dead parent)",
    dead.join() === "Bracelets,Omega,Page supprimée,Ancienne,Top ventes cachée",
  );
  check(
    "listDeadNavItems: live refs / manual href / other kinds are not candidates",
    !dead.includes("Cuir") && !dead.includes("Manuel") && !dead.includes("Nouveautés"),
  );
  // A renamed showcase slug (rename 301) keeps its stored URL working: re-admit it.
  const redirected = admitNavRefs(live, [tree[1], tree[9]]);
  const kept = pruneDeadNavItems(tree, redirected).map((n) => n.label);
  check(
    "a redirected dead category ref is kept (with its live sub-items)",
    kept.includes("Bracelets") &&
      pruneDeadNavItems(tree, redirected).find((n) => n.label === "Bracelets")!.children.length === 1,
  );
  check("a redirected system (showcase) ref is kept", kept.includes("Top ventes cachée"));
  check("other dead refs are still dropped after admitting one", !kept.includes("Omega"));
  check(
    "admitNavRefs never mutates the shared live set",
    !live.category.has("bracelets") &&
      redirected.category.has("bracelets") &&
      !live.system.has("top-ventes") &&
      redirected.system.has("top-ventes"),
  );
  check("admitNavRefs with nothing to admit returns the same sets", admitNavRefs(live, []) === live);
  const cmsSrc = read("src/lib/api/cms.ts");
  check(
    "footer columns + main menu both go through the pruning",
    (cmsSrc.match(/pruneDeadMenuLinks\(/g) ?? []).length >= 3,
  );
  check(
    "pruning re-admits refs an active redirect serves (switch honored)",
    cmsSrc.includes("admitRedirectedNavRefs(trees, loaded)") &&
      cmsSrc.includes("isRedirectsEnabled()") &&
      cmsSrc.includes("redirectQueries.findActiveBySource("),
  );
  check(
    "live system set = VISIBLE showcase slugs (fail-open on a settings read error)",
    cmsSrc.includes("COLLECTION_SLUGS.filter((s) => asBool(settings[`pages.${s}.visible`], true))") &&
      cmsSrc.includes("getSettingsMap().catch("),
  );
  const editorSrc = read("src/app/admin/cms/_components/nav-menu-editor.tsx");
  check(
    "admin menu rows flag a link the storefront drops (same checked kinds)",
    editorSrc.includes("checkedNavKind(") && editorSrc.includes("hasDeadTarget(item, targets)"),
  );
  const targetsSrc = read("src/lib/api/link-targets.ts");
  check(
    "link picker offers only storefront-visible (chain-active) categories",
    targetsSrc.includes("isCategoryChainActive(buildCategoryChain("),
  );

  // ── 3. Home CTA fallbacks + 404 link point at real routes ───────────────
  console.log("home CTA fallbacks + 404 link:");
  const fallbacks: [string, string][] = [
    ["fiftyfifty.href", HOME_DEFAULTS.fiftyfifty.href],
    ["appointment.href", HOME_DEFAULTS.appointment.href],
    ["complications.href", HOME_DEFAULTS.complications.href],
    ["heritage.ctaHref", HOME_DEFAULTS.heritage.ctaHref],
  ];
  for (const [key, href] of fallbacks) {
    check(`HOME_DEFAULTS.${key} (${href}) is a storefront route`, isStorefrontRoute(href));
  }
  check("route check rejects a dead path (/produits)", !isStorefrontRoute("/produits"));
  const notFoundSrc = read("src/components/not-found-scene.tsx");
  // The scene recovers via a literal primary href, the QUICK_LINKS array
  // (`href: "/…"`) and the native search `action` — all must be real routes.
  const notFoundHrefs = [
    ...[...notFoundSrc.matchAll(/href="(\/[^"]*)"/g)].map((m) => m[1]),
    ...[...notFoundSrc.matchAll(/href:\s*"(\/[^"]*)"/g)].map((m) => m[1]),
    ...[...notFoundSrc.matchAll(/action="(\/[^"]*)"/g)].map((m) => m[1]),
  ];
  check("404 scene has its recovery CTAs (home + quick links + search)", notFoundHrefs.length >= 2);
  check(
    `every 404 recovery target is a storefront route (${notFoundHrefs.join(", ")})`,
    notFoundHrefs.every(isStorefrontRoute),
  );

  // ── 4. Wiring guards ────────────────────────────────────────────────────
  console.log("wiring guards:");
  const headerSrc = read("src/components/site-header.tsx");
  // The nav is now DATA-DRIVEN: the resolver (nav-composer.ts) turns the
  // materialized `main` nav_items into roots, carrying the admin icon + new-tab
  // flag; the header renders the resolved roots (no hardcoded buildNavRoots).
  const navComposerSrc = read("src/lib/api/nav-composer.ts");
  check(
    "nav roots carry the admin icon + new-tab flag (resolver)",
    navComposerSrc.includes("icon: it.icon") && navComposerSrc.includes("newTab: it.open_in_new_tab"),
  );
  check(
    "header renders target=_blank + noopener for new-tab items",
    headerSrc.includes('target: "_blank"') && headerSrc.includes("noopener noreferrer"),
  );
  check(
    "header is fully data-driven (no hardcoded buildNavRoots)",
    !headerSrc.includes("function buildNavRoots"),
  );
  check(
    "manifest is rendered per request (not baked at a no-DB build)",
    /export const dynamic = "force-dynamic"/.test(read("src/app/manifest.ts")),
  );
  // The live storefront home is the Tokyo fixed-component page under (tokyo); the
  // best-sellers source="best_sellers" still resolves through listProductsForSource
  // (products.ts) — used by the composer-driven admin home editor + any rail.
  const homeSrc = read("src/app/(shop)/(tokyo)/page.tsx");
  const productsSrc = read("src/lib/api/products.ts");
  check(
    "home best-sellers source uses the sales ranking (getTopSellingProducts)",
    productsSrc.includes("getTopSellingProducts("),
  );
  check(
    "best-sellers source hides on no-sale (does NOT fall back to Nouveautés)",
    /case "best_sellers":[\s\S]{0,400}?return \[\];/.test(productsSrc),
  );
  check(
    "storefront home renders its Tokyo sections (hero + extras)",
    homeSrc.includes("<HeroCarousel") && homeSrc.includes("<HomeExtras"),
  );

  // ── 5. Kawn attribution is present + immutable (contractual) ─────────────
  // The component's own comment promises automated tests verify it isn't stripped
  // or made configurable; this is that guard.
  console.log("Kawn attribution (non-removable):");
  const kawnSrc = read("src/components/kawn-attribution.tsx");
  check("renders the exact contractual URL", kawnSrc.includes("https://kawn.me"));
  check("renders the exact contractual name", kawnSrc.includes("Kawn Digital Studio"));
  check("exposes the data-kawn-attribution marker", kawnSrc.includes('data-kawn-attribution="true"'));
  check(
    "cannot be made configurable / disableable (no settings/env lookup)",
    !kawnSrc.includes("process.env") &&
      !kawnSrc.includes("getSettingsMap") &&
      !kawnSrc.includes("settings[") &&
      !kawnSrc.includes("storefront.footer"),
  );
  const footerSrc = read("src/components/site-footer.tsx");
  check(
    "the footer imports + renders <KawnAttribution/>",
    footerSrc.includes("@/components/kawn-attribution") && footerSrc.includes("<KawnAttribution"),
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
