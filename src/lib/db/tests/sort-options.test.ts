/**
 * PURE unit test for the storefront listing sort (SORT_OPTIONS + sortProducts).
 * No DB, no server-only — runs in the `test:pure` chain.
 *
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/sort-options.test.ts
 *
 * WHY: « Nouveautés » (value "newest") had no case in the category page's sort
 * switch, so it fell through to the natural order — a silent no-op identical to
 * « En vedette » on every category / brand / collection page and /recherche.
 * This pins: every SORT_OPTIONS value is implemented (only "featured" keeps the
 * incoming order), newest = published_at DESC with undated / older-cached DTOs
 * last, and the value ↔ label mapping the label-keyed page state relies on.
 */
import { SORT_OPTIONS, sortLabel, sortValue } from "@/lib/catalog/sort-options";
import { compareNewest, sortProducts } from "@/lib/catalog/sort-products";

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

type P = { slug: string; price: number; name: string; publishedAt?: string | null };

// Incoming (curated / relevance) order is deliberately none of the sorted orders.
const FIXTURE: P[] = [
  { slug: "b", price: 300, name: "Breguet", publishedAt: "2026-03-01T10:00:00.000Z" },
  { slug: "legacy", price: 150, name: "Zenith" }, // older cached DTO — no publishedAt
  { slug: "a", price: 900, name: "Audemars", publishedAt: "2026-09-20T08:30:00.000Z" },
  { slug: "c", price: 50, name: "Cartier", publishedAt: "2025-12-31T23:59:59.000Z" },
  { slug: "null", price: 500, name: "Omega", publishedAt: null },
];
const slugs = (xs: P[]) => xs.map((x) => x.slug).join(",");

function main() {
  console.log("every SORT_OPTIONS value is implemented:");
  const incoming = slugs(FIXTURE);
  for (const o of SORT_OPTIONS) {
    const out = slugs(sortProducts(FIXTURE, o.value));
    if (o.value === "featured") {
      check(`« ${o.label} » keeps the incoming order`, out === incoming);
    } else {
      check(`« ${o.label} » (${o.value}) reorders — not a silent no-op`, out !== incoming);
    }
  }

  console.log("« Nouveautés » = newest published first, undated last:");
  check(
    "newest → a (09-2026), b (03-2026), c (12-2025), then undated in incoming order",
    slugs(sortProducts(FIXTURE, "newest")) === "a,b,c,legacy,null",
  );
  check(
    "offset ISO strings compare by instant, not lexically",
    compareNewest(
      { price: 0, name: "x", publishedAt: "2026-01-01T01:00:00+02:00" }, // 2025-12-31T23:00Z
      { price: 0, name: "y", publishedAt: "2025-12-31T23:30:00.000Z" },
    ) > 0,
  );
  check(
    "unparseable date sorts like a missing one (after dated)",
    compareNewest({ price: 0, name: "x", publishedAt: "pas une date" }, { price: 0, name: "y", publishedAt: "2020-01-01T00:00:00Z" }) > 0,
  );
  check("two undated products tie (stable)", compareNewest({ price: 0, name: "x" }, { price: 0, name: "y", publishedAt: null }) === 0);

  console.log("price / name sorts:");
  check("price_asc", slugs(sortProducts(FIXTURE, "price_asc")) === "c,legacy,b,null,a");
  check("price_desc", slugs(sortProducts(FIXTURE, "price_desc")) === "a,null,b,legacy,c");
  check("name (fr collation)", slugs(sortProducts(FIXTURE, "name")) === "a,b,c,null,legacy");

  console.log("purity:");
  const before = slugs(FIXTURE);
  sortProducts(FIXTURE, "price_desc");
  check("input array is never mutated", slugs(FIXTURE) === before);
  check("returns a new array even for featured", sortProducts(FIXTURE, "featured") !== FIXTURE);

  console.log("value ↔ label mapping (the page state is label-keyed):");
  for (const o of SORT_OPTIONS) {
    check(`« ${o.label} » ⇄ ${o.value}`, sortLabel(o.value) === o.label && sortValue(o.label) === o.value);
  }
  check("unknown value → default « En vedette »", sortLabel("nope") === "En vedette");
  check("unknown label → default featured", sortValue("Nope") === "featured");
  check("« Nouveautés » is offered", SORT_OPTIONS.some((o) => o.value === "newest" && o.label === "Nouveautés"));

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
