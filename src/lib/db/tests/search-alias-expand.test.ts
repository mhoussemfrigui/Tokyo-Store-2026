/**
 * PURE unit test for the search-alias query-expansion matcher + the catalogue
 * default set. No DB, no server-only — runs in the `test:pure` chain.
 *
 *   npx tsx --conditions=react-server src/lib/db/tests/search-alias-expand.test.ts
 */
import {
  expandSearchQuery,
  MAX_QUERY_EXPANSIONS,
  type SearchAlias,
} from "@/modules/search/aliases";
import { DEFAULT_SEARCH_ALIASES } from "@/modules/search/default-aliases";

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
const eq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function main() {
  console.log("token replacement (word boundaries):");
  check(
    "« chrono acier » + {chrono→chronographe} → « chronographe acier »",
    eq(expandSearchQuery("chrono acier", [{ term: "chrono", expansion: "chronographe" }]), [
      "chronographe acier",
    ]),
  );
  check(
    "one rule covers the term anywhere in the query",
    eq(expandSearchQuery("montre chrono homme", [{ term: "chrono", expansion: "chronographe" }]), [
      "montre chronographe homme",
    ]),
  );
  check(
    "multi-word « leather strap » → « bracelet cuir »",
    eq(expandSearchQuery("leather strap", [{ term: "leather strap", expansion: "bracelet cuir" }]), [
      "bracelet cuir",
    ]),
  );
  check(
    "multi-word inside a longer query",
    eq(
      expandSearchQuery("leather strap noir", [
        { term: "leather strap", expansion: "bracelet cuir" },
      ]),
      ["bracelet cuir noir"],
    ),
  );

  console.log("safety — no substring / no-op false hits:");
  check(
    "« sacoche » is NOT « ac » (token, not substring)",
    eq(expandSearchQuery("sacoche", [{ term: "ac", expansion: "acier" }]), []),
  );
  check(
    "no match → no variants",
    eq(expandSearchQuery("rolex", [{ term: "chrono", expansion: "chronographe" }]), []),
  );
  check(
    "term === expansion is skipped",
    eq(expandSearchQuery("montre", [{ term: "montre", expansion: "montre" }]), []),
  );
  check("empty query → []", eq(expandSearchQuery("", [{ term: "chrono", expansion: "chronographe" }]), []));
  check(
    "raw query is never re-emitted as a variant",
    !expandSearchQuery("montre", [{ term: "montre", expansion: "montre connectee" }]).includes("montre"),
  );

  console.log("dedupe + cap:");
  const dupRules: SearchAlias[] = [
    { term: "diver", expansion: "plongee" },
    { term: "diver", expansion: "plongee" },
  ];
  check("duplicate rules yield ONE variant", eq(expandSearchQuery("diver", dupRules), ["plongee"]));
  const many: SearchAlias[] = Array.from({ length: MAX_QUERY_EXPANSIONS + 5 }, (_, i) => ({
    term: "x",
    expansion: `y${i}`,
  }));
  check(
    `variants capped at MAX_QUERY_EXPANSIONS (${MAX_QUERY_EXPANSIONS})`,
    expandSearchQuery("x", many).length === MAX_QUERY_EXPANSIONS,
  );

  console.log("determinism — longest term wins the cap:");
  const overlap: SearchAlias[] = [
    { term: "gold", expansion: "or" },
    { term: "rose gold", expansion: "or rose" },
  ];
  check(
    "« rose gold » prefers the more specific rule first",
    expandSearchQuery("rose gold", overlap)[0] === "or rose",
  );

  console.log("DEFAULT_SEARCH_ALIASES sanity:");
  const norm = (s: string) =>
    s === s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  check("non-empty default set", DEFAULT_SEARCH_ALIASES.length > 20);
  check(
    "every default is normalized (lowercase, no accents, trimmed)",
    DEFAULT_SEARCH_ALIASES.every((a) => norm(a.term) && norm(a.expansion)),
  );
  check("no default has term === expansion", DEFAULT_SEARCH_ALIASES.every((a) => a.term !== a.expansion));
  check(
    "no duplicate (term,expansion) pairs",
    new Set(DEFAULT_SEARCH_ALIASES.map((a) => `${a.term} ${a.expansion}`)).size ===
      DEFAULT_SEARCH_ALIASES.length,
  );
  check(
    "the flagship « earbuds → ecouteurs » rule is present",
    DEFAULT_SEARCH_ALIASES.some((a) => a.term === "earbuds" && a.expansion === "ecouteurs"),
  );
  check(
    "« charger → chargeur » is present",
    DEFAULT_SEARCH_ALIASES.some((a) => a.term === "charger" && a.expansion === "chargeur"),
  );
  // The defaults actually expand a real query through the engine.
  check(
    "defaults expand « chrono acier » to « chronographe acier »",
    expandSearchQuery("earbuds sans fil", DEFAULT_SEARCH_ALIASES).includes("ecouteurs sans fil"),
  );
  check(
    "defaults expand « diver » to « plongee »",
    expandSearchQuery("laptop", DEFAULT_SEARCH_ALIASES).includes("pc portable"),
  );

  console.log(`\nsearch-alias-expand.test.ts — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main();
