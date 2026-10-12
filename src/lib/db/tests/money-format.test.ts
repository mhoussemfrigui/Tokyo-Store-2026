/**
 * Pure money formatters — the new currency + position params on formatMoney
 * (the global-currency relabel) + formatMoneyWithCurrency's per-currency default.
 * No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/money-format.test.ts
 */
import {
  formatMoney,
  formatMoneyWithCurrency,
  formatMoneyExact,
  formatCents,
  formatMoneyMachine,
  minorToDinars,
  dinarsToMinor,
} from "@/lib/price";

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
// fr-FR toLocaleString may group with a non-breaking / narrow space; JS \s
// matches those, so collapse to a plain space for a glyph-agnostic compare.
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const eq = (a: string, b: string) => norm(a) === norm(b);

function main() {
  console.log("formatMoney — back-compat (default TND, after):");
  check("250000 -> 250 TND", eq(formatMoney(250000), "250 TND"));
  check("250000 @3dp -> 250,000 TND", eq(formatMoney(250000, 3), "250,000 TND"));
  check("0 -> 0 TND", eq(formatMoney(0), "0 TND"));

  console.log("formatMoney — currency + position:");
  check("EUR after", eq(formatMoney(250000, 0, "EUR", "after"), "250 EUR"));
  check("$ before (space + order)", eq(formatMoney(250000, 0, "$", "before"), "$ 250"));
  check("symbol before keeps decimals", eq(formatMoney(250000, 3, "DT", "before"), "DT 250,000"));

  console.log("formatMoney — decimals clamp (millime max 3):");
  check("9 clamps to 3dp", eq(formatMoney(1234, 9), "1,234 TND"));
  check("-2 clamps to 0dp", eq(formatMoney(1234, -2), "1 TND"));
  check("2.9 truncs to 2dp", eq(formatMoney(1500, 2.9), "1,50 TND"));

  console.log("formatMoneyWithCurrency — per-currency default decimals:");
  check("TND defaults to 3dp", eq(formatMoneyWithCurrency(250000, "TND"), "250,000 TND"));
  check("foreign defaults to 2dp", eq(formatMoneyWithCurrency(250000, "EUR"), "250,00 EUR"));
  check("explicit decimals override", eq(formatMoneyWithCurrency(250000, "EUR", 0), "250 EUR"));

  console.log("minorToDinars / dinarsToMinor — the scale (millimes ×1000):");
  check("minorToDinars 250000 -> 250", minorToDinars(250000) === 250);
  check("minorToDinars 1234 -> 1.234", minorToDinars(1234) === 1.234);
  // NaN/undefined guard: `minor || 0`.
  check("minorToDinars NaN -> 0", minorToDinars(NaN) === 0);
  check("dinarsToMinor 250 -> 250000", dinarsToMinor(250) === 250000);
  check("dinarsToMinor 1.234 -> 1234", dinarsToMinor(1.234) === 1234);
  // Rounds to the nearest millime (1.2345 * 1000 = 1234.5 -> 1235), so a
  // sub-millime input can never persist a fractional integer column.
  check("dinarsToMinor rounds half up", dinarsToMinor(1.2345) === 1235);
  check("dinarsToMinor non-numeric -> 0", dinarsToMinor(Number("abc")) === 0);
  // Round-trip is lossless for any integer millime amount.
  check(
    "round-trip integer minor is lossless",
    [0, 1, 999, 250000, 1234567].every((m) => dinarsToMinor(minorToDinars(m)) === m),
  );

  console.log("formatCents — whole-TND storefront default:");
  check("250000 -> 250 TND", eq(formatCents(250000), "250 TND"));
  check("rounds to whole dinar by default", eq(formatCents(250499), "250 TND"));
  check("honours explicit decimals", eq(formatCents(250500, 3), "250,500 TND"));

  console.log("formatMoneyExact — invoice/receipt precision (decimals only when fractional):");
  check("whole amount reads clean (no decimals)", eq(formatMoneyExact(250000), "250 TND"));
  check("fractional keeps full millime precision", eq(formatMoneyExact(250500), "250,500 TND"));
  check("sub-dinar amount", eq(formatMoneyExact(1), "0,001 TND"));
  check("0 -> 0 TND", eq(formatMoneyExact(0), "0 TND"));
  check("currency + before position label", eq(formatMoneyExact(250500, "$", "before"), "$ 250,500"));

  console.log("formatMoneyMachine — feed/JSON-LD plain-decimal (never below millime 3dp):");
  check("7500 -> 7.500 (never 7.50)", formatMoneyMachine(7500) === "7.500");
  check("169000 -> 169.000", formatMoneyMachine(169000) === "169.000");
  check("0 -> 0.000", formatMoneyMachine(0) === "0.000");
  check("no fr-FR grouping / comma", !/[, ]/.test(formatMoneyMachine(1234567)));
  check("decimals below 3 are floored to 3", formatMoneyMachine(7500, 0) === "7.500");
  check("decimals up to 4 honoured", formatMoneyMachine(7500, 4) === "7.5000");
  check("decimals above 4 clamped to 4", formatMoneyMachine(7500, 9) === "7.5000");

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
