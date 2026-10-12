/**
 * Pure storefront-grid cap (capGridIds / MAX_GRID_PRODUCTS) — the safety ceiling
 * that bounds how many products a category/brand/collection grid loads in one
 * request. No DB / server deps.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/grid-cap.test.ts
 */
import { capGridIds, MAX_GRID_PRODUCTS } from "@/lib/catalog/grid-cap";

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

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

function main() {
  console.log("capGridIds:");
  check("empty → empty (same ref)", (() => { const a: string[] = []; return capGridIds(a, "t") === a; })());
  check("below cap → identity (same ref, not copied)", (() => { const a = ids(10); return capGridIds(a, "t") === a; })());
  check("just below cap kept whole", capGridIds(ids(MAX_GRID_PRODUCTS - 1), "t").length === MAX_GRID_PRODUCTS - 1);
  check("exactly cap → unchanged (same ref, no slice)", (() => { const a = ids(MAX_GRID_PRODUCTS); return capGridIds(a, "t") === a; })());
  check("over cap → sliced to cap", capGridIds(ids(MAX_GRID_PRODUCTS + 1), "t").length === MAX_GRID_PRODUCTS);
  check("way over cap → sliced to cap", capGridIds(ids(50_000), "t").length === MAX_GRID_PRODUCTS);
  check(
    "over cap keeps the FIRST N in order (newest-first contract)",
    (() => {
      const out = capGridIds(ids(MAX_GRID_PRODUCTS + 5), "t");
      return out[0] === "id-0" && out[MAX_GRID_PRODUCTS - 1] === `id-${MAX_GRID_PRODUCTS - 1}`;
    })(),
  );
  check("over cap returns a NEW array (doesn't mutate input)", (() => {
    const a = ids(MAX_GRID_PRODUCTS + 1);
    const out = capGridIds(a, "t");
    return out !== a && a.length === MAX_GRID_PRODUCTS + 1;
  })());
  check("cap is the documented 2000", MAX_GRID_PRODUCTS === 2000);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
