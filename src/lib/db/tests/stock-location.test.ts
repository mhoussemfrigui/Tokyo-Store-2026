/**
 * Multi-location cached-total maintenance (nextTotalForLevelWrite) — the pure
 * decision that keeps products/product_variants.stock_qty correct as the SUM of
 * per-location levels, while preserving concurrent order decrements — plus the
 * location create/edit form parsing (location-form.ts): the "Emplacement actif"
 * checkbox semantics and the carrier_ref keep-when-hidden rule. No DB. Run:
 *   pnpm exec tsx src/lib/db/tests/stock-location.test.ts
 */
import { nextTotalForLevelWrite } from "@/lib/inventory/level-total";
import { carrierRefPatch, parseLocationActive } from "@/lib/inventory/location-form";

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

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
  // Untracked target (NULL total) → becomes the sum of active-location levels.
  check("untracked → sum of levels", nextTotalForLevelWrite(null, 10, 10) === 10);
  check("untracked, multi-location → full sum", nextTotalForLevelWrite(null, 5, 23) === 23);
  check("untracked, all-zero levels → 0", nextTotalForLevelWrite(null, 0, 0) === 0);

  // Tracked target → moves by the delta (preserves a concurrent sale).
  check("tracked: +5 delta on 10 → 15", nextTotalForLevelWrite(10, 5, 0) === 15);
  check(
    "tracked: a sale already dropped total 10→7, +2 admin delta → 9 (sale kept)",
    nextTotalForLevelWrite(7, 2, 0) === 9,
  );
  check("tracked: -3 delta on 10 → 7", nextTotalForLevelWrite(10, -3, 0) === 7);
  check("tracked: delta floors at 0 (never negative)", nextTotalForLevelWrite(2, -5, 0) === 0);
  check("tracked: zero delta is a no-op", nextTotalForLevelWrite(8, 0, 0) === 8);

  // Defensive: never write NaN / negative / fractional to stock_qty.
  check("untracked: NaN sum → 0", nextTotalForLevelWrite(null, 0, Number.NaN) === 0);
  check("untracked: negative sum → 0", nextTotalForLevelWrite(null, 0, -4) === 0);
  check("untracked: fractional sum floored", nextTotalForLevelWrite(null, 0, 4.9) === 4);
  check("tracked: NaN delta → 0", nextTotalForLevelWrite(5, Number.NaN, 0) === 0);

  // "Emplacement actif" checkbox: a native checkbox posts "on" when ticked and
  // NOTHING when unticked (the old `!== "off"` test could never deactivate).
  check("active box ticked ('on') → active", parseLocationActive(form({ is_active: "on" }), false) === true);
  check("active box unticked (key absent) → INACTIVE", parseLocationActive(form({ name: "Annexe" }), false) === false);
  check("a stray 'off' value is not 'on' → inactive", parseLocationActive(form({ is_active: "off" }), false) === false);
  check("default location stays active even without the box", parseLocationActive(form({ name: "Main" }), true) === true);

  // carrier_ref: the select is only rendered while the link feature is on — a
  // missing key must KEEP the stored link (was: nulled on every rename).
  const uuid = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
  check("carrier select hidden (key absent) → no carrier_ref in the patch", !("carrier_ref" in carrierRefPatch(form({ name: "X" }))));
  check("carrier select shown with a uuid → set", carrierRefPatch(form({ carrier_ref: uuid })).carrier_ref === uuid);
  check("carrier select shown on « — Aucun — » (blank) → cleared", carrierRefPatch(form({ carrier_ref: "" })).carrier_ref === null);
  check("carrier select with junk → cleared (uuid-only)", carrierRefPatch(form({ carrier_ref: "not-a-uuid" })).carrier_ref === null);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
process.exit(0);
