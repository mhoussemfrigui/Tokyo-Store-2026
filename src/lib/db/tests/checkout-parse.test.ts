/**
 * Pure checkout-setting parsers (delivery day-counts / cents, labels, booleans).
 * No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/checkout-parse.test.ts
 */
import { parseCents, trimOrNull, parseBool } from "@/lib/checkout/parse";

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
  console.log("parseCents (also delivery day-counts):");
  check("null -> null", parseCents(null) === null);
  check("'' -> null", parseCents("") === null);
  check("'  ' -> null", parseCents("   ") === null);
  check("'abc' -> null", parseCents("abc") === null);
  check("'-1' -> null (negative)", parseCents("-1") === null);
  check("'0' -> 0", parseCents("0") === 0);
  check("'3' -> 3", parseCents("3") === 3);
  check("'2.7' -> 3 (rounds)", parseCents("2.7") === 3);
  check("' 4 ' -> 4 (trims)", parseCents(" 4 ") === 4);

  console.log("trimOrNull:");
  check("null -> null", trimOrNull(null) === null);
  check("'  ' -> null", trimOrNull("  ") === null);
  check("' x ' -> 'x'", trimOrNull(" x ") === "x");

  console.log("parseBool:");
  check("null -> fallback(true)", parseBool(null, true) === true);
  check("'' -> fallback(false)", parseBool("", false) === false);
  check("'true' -> true", parseBool("true", false) === true);
  check("'TRUE' -> true", parseBool("TRUE", false) === true);
  check("'false' -> false", parseBool("false", true) === false);
  check("'yes' -> false (only 'true' is true)", parseBool("yes", true) === false);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
