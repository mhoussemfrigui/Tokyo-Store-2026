/**
 * Pure currency helpers — admin-input normalizers, the row→ActiveCurrency mapper,
 * the TND default, and the delete-active guard. No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/currency-normalize.test.ts
 */
import {
  normalizeCode,
  normalizePosition,
  clampInt,
  canDeleteCurrency,
  rowToActiveCurrency,
  DEFAULT_CURRENCY,
} from "@/lib/currency/normalize";

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
  console.log("normalizeCode:");
  check("'tnd' -> TND", normalizeCode("tnd") === "TND");
  check("'eur ' -> EUR", normalizeCode("eur ") === "EUR");
  check("'us$d2' -> USD (strip non-letters)", normalizeCode("us$d2") === "USD");
  check("'abcd' -> ABC (slice 3)", normalizeCode("abcd") === "ABC");
  check("'' -> ''", normalizeCode("") === "");
  check("null -> ''", normalizeCode(null) === "");

  console.log("normalizePosition:");
  check("'before' -> before", normalizePosition("before") === "before");
  check("'after' -> after", normalizePosition("after") === "after");
  check("garbage -> after", normalizePosition("x") === "after");
  check("null -> after", normalizePosition(null) === "after");

  console.log("clampInt:");
  check("'3' -> 3", clampInt("3", 3) === 3);
  check("'9' max 6 -> 6", clampInt("9", 3) === 6);
  check("'9' max 9999 -> 9", clampInt("9", 0, 9999) === 9);
  check("'-1' -> fallback", clampInt("-1", 2) === 2);
  check("'abc' -> fallback", clampInt("abc", 2) === 2);
  check("'2.9' -> 2 (trunc)", clampInt("2.9", 0) === 2);
  check("'10000' max 9999 -> 9999", clampInt("10000", 0, 9999) === 9999);

  console.log("canDeleteCurrency:");
  check("same id -> false", canDeleteCurrency("a", "a") === false);
  check("different id -> true", canDeleteCurrency("a", "b") === true);
  check("no active -> true", canDeleteCurrency(null, "b") === true);

  console.log("DEFAULT_CURRENCY + rowToActiveCurrency:");
  check(
    "default is TND/after",
    DEFAULT_CURRENCY.code === "TND" && DEFAULT_CURRENCY.symbolPosition === "after",
  );
  const mapped = rowToActiveCurrency({
    code: "EUR",
    name: "Euro",
    symbol: "€",
    symbol_position: "before",
  });
  check(
    "maps symbol_position -> symbolPosition",
    mapped.code === "EUR" && mapped.symbol === "€" && mapped.symbolPosition === "before",
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
