import "server-only";

/**
 * Pure business helpers that live in server-only / db-importing modules (so they
 * need the env to IMPORT, but touch no DB at runtime): the variant-stock mode
 * resolver (isSharedStock) and the store-timezone date parts (storeMonth /
 * storeDay / storeYear). In test:db purely because importing their modules pulls
 * in the db client.
 *
 * Run via `pnpm test:db` or:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/server-pure-helpers.test.ts
 */
import { isSharedStock } from "@/lib/inventory/variant-stock";
import { storeMonth, storeDay, storeYear } from "@/lib/promotions/segments";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

function main() {
  console.log("isSharedStock — per-product override wins, else the global default:");
  check("override true wins", isSharedStock(true, false) === true);
  check("override false wins", isSharedStock(false, true) === false);
  check("null → global default (true)", isSharedStock(null, true) === true);
  check("undefined → global default (false)", isSharedStock(undefined, false) === false);

  console.log("store-TZ date parts (Africa/Tunis, UTC+1):");
  // 2026-01-31 23:30 UTC = 2026-02-01 00:30 Tunis → month rolls to Feb, day 1.
  const rollover = new Date("2026-01-31T23:30:00Z");
  check("storeMonth rolls Jan-31 23:30Z → 2 (Feb)", storeMonth(rollover) === 2);
  check("storeDay rolls to 1", storeDay(rollover) === 1);
  check("storeYear stays 2026", storeYear(rollover) === 2026);
  // 2026-12-31 23:30 UTC = 2027-01-01 Tunis → year rolls.
  check("storeYear rolls Dec-31 23:30Z → 2027", storeYear(new Date("2026-12-31T23:30:00Z")) === 2027);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
