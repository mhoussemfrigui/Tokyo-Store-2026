/**
 * Pure product-condition (état) mappings — schema.org Offer.itemCondition URL +
 * French label, both defaulting to NEW for unset/unknown. No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/condition.test.ts
 */
import { conditionSchemaUrl, conditionLabelFr } from "@/lib/catalog/condition";

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

function main() {
  console.log("conditionSchemaUrl:");
  check("new", conditionSchemaUrl("new") === "https://schema.org/NewCondition");
  check("used", conditionSchemaUrl("used") === "https://schema.org/UsedCondition");
  check("refurbished", conditionSchemaUrl("refurbished") === "https://schema.org/RefurbishedCondition");
  check("undefined -> New", conditionSchemaUrl(undefined) === "https://schema.org/NewCondition");
  check("null -> New", conditionSchemaUrl(null) === "https://schema.org/NewCondition");
  check("'' -> New", conditionSchemaUrl("") === "https://schema.org/NewCondition");
  check("garbage -> New", conditionSchemaUrl("xyz") === "https://schema.org/NewCondition");

  console.log("conditionLabelFr:");
  check("new -> Neuf", conditionLabelFr("new") === "Neuf");
  check("used -> Occasion", conditionLabelFr("used") === "Occasion");
  check("refurbished -> Reconditionné", conditionLabelFr("refurbished") === "Reconditionné");
  check("undefined -> Neuf", conditionLabelFr(undefined) === "Neuf");
  check("garbage -> Neuf", conditionLabelFr("USED") === "Neuf"); // case-sensitive

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
