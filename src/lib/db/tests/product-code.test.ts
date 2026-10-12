/**
 * Product REFERENCE helper (src/lib/catalog/product-code.ts) — the customer-facing
 * reference string shared by the PDP info pill, the Détails row, and the JSON-LD
 * `sku`. No DB. (The former scannable product-code feature was removed.) Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/product-code.test.ts
 */
import { productReference } from "@/lib/catalog/product-code";

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
  check("real SKU → the SKU verbatim", productReference("TWS-001", "casque-bluetooth") === "TWS-001");
  check("SKU is trimmed", productReference("  TWS-2  ", "x") === "TWS-2");
  check(
    "no SKU → TK-<SLUG> fallback (uppercased)",
    productReference(null, "casque-bluetooth") === "TK-CASQUE-BLUETOOTH",
  );
  check("blank SKU → TK-<SLUG> fallback", productReference("   ", "abc") === "TK-ABC");
  check("undefined SKU → TK-<SLUG> fallback", productReference(undefined, "abc") === "TK-ABC");

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
process.exit(0);
