/**
 * variantInStock — the PURE availability resolver that gates PDP visibility, the
 * variant picker, listing cards, and the API "inStock". A regression here would
 * silently advertise unbuyable products (or hide buyable ones), so the full
 * in_stock × stock_qty matrix is pinned here. No DB. Run:
 *   pnpm exec tsx src/lib/db/tests/variant-stock.test.ts
 */
import { variantInStock } from "@/types/catalog";

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
  // in_stock flag OFF → never available, regardless of qty.
  check("off + null qty (untracked) → unavailable", variantInStock({ inStock: false, stockQty: null }) === false);
  check("off + positive qty → unavailable", variantInStock({ inStock: false, stockQty: 7 }) === false);
  check("off + zero qty → unavailable", variantInStock({ inStock: false, stockQty: 0 }) === false);

  // in_stock flag ON → availability follows the tracked quantity.
  check("on + null qty (untracked = unlimited) → available", variantInStock({ inStock: true, stockQty: null }) === true);
  check("on + positive qty → available", variantInStock({ inStock: true, stockQty: 3 }) === true);
  check("on + qty 1 (last unit) → available", variantInStock({ inStock: true, stockQty: 1 }) === true);

  // The load-bearing edge: in_stock=true but tracked to ZERO must read as SOLD OUT.
  check("on + zero qty → UNAVAILABLE (sold out)", variantInStock({ inStock: true, stockQty: 0 }) === false);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
process.exit(0);
