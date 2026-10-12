/**
 * Pure storefront faceted-filter predicate (productMatchesAttributeFilters) — the
 * core attribute-filter correctness logic shared by category-client.tsx. No
 * React/DOM deps.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/attribute-filter.test.ts
 */
import {
  productMatchesAttributeFilters,
  type AttributeFilterInput,
} from "@/lib/catalog/attribute-filter";

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

const base: AttributeFilterInput = {
  productValueIds: [],
  productNumericValues: undefined,
  attrFilters: {},
  activeAttrIds: [],
  numericFilters: {},
  activeNumericIds: [],
};
const m = (o: Partial<AttributeFilterInput>) => productMatchesAttributeFilters({ ...base, ...o });
const set = (...ids: string[]) => new Set(ids);

function main() {
  console.log("no active filters:");
  check("empty filters → pass", m({}) === true);
  check("product with values, no active filters → pass", m({ productValueIds: ["red"] }) === true);

  console.log("value-list — OR within an attribute:");
  check(
    "product has one of two wanted values → pass",
    m({ productValueIds: ["red"], attrFilters: { color: set("red", "blue") }, activeAttrIds: ["color"] }) === true,
  );
  check(
    "product has none of the wanted values → fail",
    m({ productValueIds: ["green"], attrFilters: { color: set("red", "blue") }, activeAttrIds: ["color"] }) === false,
  );
  check(
    "product carries no values at all → fail an active value filter",
    m({ productValueIds: [], attrFilters: { color: set("red") }, activeAttrIds: ["color"] }) === false,
  );
  check(
    "an empty wanted set is ignored (not a constraint)",
    m({ productValueIds: ["x"], attrFilters: { color: set() }, activeAttrIds: ["color"] }) === true,
  );

  console.log("value-list — AND across attributes:");
  check(
    "matches BOTH attributes → pass",
    m({
      productValueIds: ["red", "steel"],
      attrFilters: { color: set("red"), material: set("steel") },
      activeAttrIds: ["color", "material"],
    }) === true,
  );
  check(
    "matches one attribute but not the other → fail",
    m({
      productValueIds: ["red", "gold"],
      attrFilters: { color: set("red"), material: set("steel") },
      activeAttrIds: ["color", "material"],
    }) === false,
  );

  console.log("number range — carry + bounds:");
  const numF = { diameter: { min: 38, max: 42 } };
  check(
    "value inside range → pass",
    m({ productNumericValues: { diameter: 40 }, numericFilters: numF, activeNumericIds: ["diameter"] }) === true,
  );
  check(
    "value at the inclusive min/max → pass",
    m({ productNumericValues: { diameter: 38 }, numericFilters: numF, activeNumericIds: ["diameter"] }) === true &&
      m({ productNumericValues: { diameter: 42 }, numericFilters: numF, activeNumericIds: ["diameter"] }) === true,
  );
  check(
    "value below min → fail",
    m({ productNumericValues: { diameter: 36 }, numericFilters: numF, activeNumericIds: ["diameter"] }) === false,
  );
  check(
    "value above max → fail",
    m({ productNumericValues: { diameter: 44 }, numericFilters: numF, activeNumericIds: ["diameter"] }) === false,
  );
  check(
    "product MISSING the numeric value → fail (can't range-match a missing spec)",
    m({ productNumericValues: {}, numericFilters: numF, activeNumericIds: ["diameter"] }) === false,
  );
  check(
    "productNumericValues undefined → fail an active number filter",
    m({ productNumericValues: undefined, numericFilters: numF, activeNumericIds: ["diameter"] }) === false,
  );

  console.log("combined value-list AND number:");
  check(
    "passes value filter AND number range → pass",
    m({
      productValueIds: ["red"],
      productNumericValues: { diameter: 40 },
      attrFilters: { color: set("red") },
      activeAttrIds: ["color"],
      numericFilters: numF,
      activeNumericIds: ["diameter"],
    }) === true,
  );
  check(
    "passes value but fails number range → fail",
    m({
      productValueIds: ["red"],
      productNumericValues: { diameter: 50 },
      attrFilters: { color: set("red") },
      activeAttrIds: ["color"],
      numericFilters: numF,
      activeNumericIds: ["diameter"],
    }) === false,
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
