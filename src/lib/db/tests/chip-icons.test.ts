/**
 * Chip-icon registry contract — the curated icon set shared by
 * the admin IconPicker and the storefront listing strip. Pure, no DB / no React
 * render; runs without Docker.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/chip-icons.test.ts
 */
import { CHIP_ICON_OPTIONS } from "@/lib/catalog/chip-icons";

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
  console.log("CHIP_ICON_OPTIONS:");
  check("non-empty curated set", CHIP_ICON_OPTIONS.length >= 12);
  check(
    "every option has key + label + Icon",
    CHIP_ICON_OPTIONS.every((o) => Boolean(o.key) && Boolean(o.label) && Boolean(o.Icon)),
  );
  check(
    "keys are unique (a dupe would make a selection ambiguous)",
    new Set(CHIP_ICON_OPTIONS.map((o) => o.key)).size === CHIP_ICON_OPTIONS.length,
  );
  check(
    "keys are stable identifiers (no spaces / safe to persist)",
    CHIP_ICON_OPTIONS.every((o) => /^[A-Za-z0-9_-]+$/.test(o.key)),
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
