/**
 * Pure feed→category mapper (src/lib/import/category-map.ts) + the Tokyo Store
 * high-tech catalog taxonomy invariant (catalog-tree.ts). No DB.
 *
 * The taxonomy is the migration feed's `canonical_category_path` (8 universes →
 * sections → items). The mapper resolves a feed breadcrumb onto the store's LIVE
 * categories (parent-aware, deepest match wins); there are no source-store
 * wording aliases and no title-keyword fallback for this taxonomy — an unmapped
 * path returns null and the runner records it.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/import-category-map.test.ts
 */
import { buildLiveCategoryIndex, resolveCategorySlug } from "@/lib/import/category-map";
import { CATALOG_TREE, type CatalogNode } from "@/lib/db/catalog-tree";

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

function allSlugs(nodes: CatalogNode[]): string[] {
  return nodes.flatMap((n) => [n.slug, ...allSlugs(n.children ?? [])]);
}

function main() {
  const rootSlugs = CATALOG_TREE.map((n) => n.slug);
  const slugs = allSlugs(CATALOG_TREE);

  console.log("taxonomy invariant — the Tokyo high-tech universes:");
  check("univers-apple is top-level", rootSlugs.includes("univers-apple"));
  check("telephonie is top-level", rootSlugs.includes("telephonie"));
  check("console-gaming is top-level", rootSlugs.includes("console-gaming"));
  check("audiovisuel is top-level", rootSlugs.includes("audiovisuel"));
  check("eight universe roots", rootSlugs.length === 8);
  check("no legacy watch roots (homme/femme/enfants)", !["homme", "femme", "enfants"].some((s) => rootSlugs.includes(s)));
  check("no standalone 'accessoires' root", !rootSlugs.includes("accessoires"));
  // "montres-connectees" (smartwatches) IS a legit Tokyo category — only the watch
  // AUDIENCE subs (montres-homme/femme/enfants) must be gone.
  check(
    "no watch audience sub-slugs (montres-homme/femme/enfants)",
    !["montres-homme", "montres-femme", "montres-enfants"].some((s) => slugs.includes(s)),
  );
  check("slugs are globally unique (flat /[slug] namespace)", new Set(slugs).size === slugs.length);
  check("a known leaf exists (casques under audiovisuel › son)", slugs.includes("casques") && slugs.includes("son"));

  console.log("resolveCategorySlug — static map = the tree's own names; no watch aliases / no title fallback:");
  // Without a live index the mapper falls back to the static alias map, which the
  // tree walk fills with every Tokyo category NAME → slug. A known tree name maps;
  // a watch-era alias and the title fallback no longer do.
  check("a known tree name maps via the static walk (Casques → casques)", resolveCategorySlug(["Casques"], "x") === "casques");
  check("an unknown segment with no live index → null", resolveCategorySlug(["Totally Unknown Xyz"], "x") === null);
  check("a watch-era alias no longer maps → null", resolveCategorySlug(["Montres femme"], "x") === null);
  check("title keyword no longer falls back → null", resolveCategorySlug([], "iPhone 15 Pro") === null);
  check("empty path → null", resolveCategorySlug([], "Nouveautés") === null);

  console.log("resolveCategorySlug — a feed breadcrumb via the LIVE tree (what the importer runs):");
  const live = buildLiveCategoryIndex([
    { id: "r-av", slug: "audiovisuel", name: "Audiovisuel", parent_id: null },
    { id: "c-son", slug: "son", name: "Son", parent_id: "r-av" },
    { id: "c-casq", slug: "casques", name: "Casques", parent_id: "c-son" },
    { id: "r-apple", slug: "univers-apple", name: "Univers Apple", parent_id: null },
    { id: "c-iph", slug: "iphone", name: "iPhone", parent_id: "r-apple" },
    { id: "c-iphn", slug: "iphones-neufs", name: "iPhones Neufs", parent_id: "c-iph" },
    { id: "r-tel", slug: "telephonie", name: "Téléphonie", parent_id: null },
  ]);
  check(
    "Audiovisuel / Son / Casques → casques (deepest match wins)",
    resolveCategorySlug(["Audiovisuel", "Son", "Casques"], "x", live) === "casques",
  );
  check(
    "Univers Apple / iPhone / iPhones Neufs → iphones-neufs",
    resolveCategorySlug(["Univers Apple", "iPhone", "iPhones Neufs"], "x", live) === "iphones-neufs",
  );
  check(
    "case / accents normalised (AUDIOVISUEL / SON)",
    resolveCategorySlug(["AUDIOVISUEL", "SON"], "x", live) === "son",
  );
  check("the exact DB slug maps too", resolveCategorySlug(["casques"], "x", live) === "casques");
  check(
    "a partial breadcrumb stops at the deepest known node (Univers Apple / iPhone)",
    resolveCategorySlug(["Univers Apple", "iPhone"], "x", live) === "iphone",
  );
  check("unmappable with live index → null", resolveCategorySlug(["Nouveautés"], "x", live) === null);

  console.log("resolveCategorySlug — same-named sub-categories under different universes:");
  const ambiguous = buildLiveCategoryIndex([
    { id: "r-pcg", slug: "pc-gaming", name: "PC Gaming", parent_id: null },
    { id: "pcg-acc", slug: "accessoires-pc-gaming", name: "Accessoires", parent_id: "r-pcg" },
    { id: "r-av", slug: "audiovisuel", name: "Audiovisuel", parent_id: null },
    { id: "av-acc", slug: "accessoires-audio", name: "Accessoires", parent_id: "r-av" },
  ]);
  check(
    "PC Gaming / Accessoires → accessoires-pc-gaming (parent-aware)",
    resolveCategorySlug(["PC Gaming", "Accessoires"], "x", ambiguous) === "accessoires-pc-gaming",
  );
  check(
    "Audiovisuel / Accessoires → accessoires-audio (not PC Gaming's, listed first)",
    resolveCategorySlug(["Audiovisuel", "Accessoires"], "x", ambiguous) === "accessoires-audio",
  );
  check(
    "bare Accessoires → ambiguous name, no global winner → null",
    resolveCategorySlug(["Accessoires"], "x", ambiguous) === null,
  );
  check(
    "an exact slug stays global (accessoires-pc-gaming)",
    resolveCategorySlug(["accessoires-pc-gaming"], "x", ambiguous) === "accessoires-pc-gaming",
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
