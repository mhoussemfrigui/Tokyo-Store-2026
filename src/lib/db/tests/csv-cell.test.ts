/**
 * Pure CSV cell encoder (src/lib/csv/cell.ts) shared by the admin export
 * routes. Locks RFC-4180 quoting AND the formula-injection guard (CWE-1236).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/csv-cell.test.ts
 */
import { csvCell } from "@/lib/csv/cell";

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
  console.log("quoting:");
  check("null → empty quoted", csvCell(null) === '""');
  check("undefined → empty quoted", csvCell(undefined) === '""');
  check("plain string quoted", csvCell("hello") === '"hello"');
  check("embedded quote doubled", csvCell('a"b') === '"a""b"');
  check("comma stays inside quotes", csvCell("a,b") === '"a,b"');
  check("newline stays inside quotes", csvCell("a\nb") === '"a\nb"');
  check("number coerced", csvCell(42) === '"42"');

  console.log("formula-injection guard (CWE-1236):");
  check("= prefixed with quote", csvCell("=cmd()") === `"'=cmd()"`);
  check("+ prefixed", csvCell("+1") === `"'+1"`);
  check("- prefixed", csvCell("-1") === `"'-1"`);
  check("@ prefixed", csvCell("@SUM(A1)") === `"'@SUM(A1)"`);
  check("leading tab prefixed", csvCell("\tx") === `"'\tx"`);
  check("HYPERLINK formula neutralised", csvCell('=HYPERLINK("http://evil","x")') === `"'=HYPERLINK(""http://evil"",""x"")"`);
  check("mid-string = not touched", csvCell("a=b") === '"a=b"');
  check("normal negative-looking text after letter ok", csvCell("total -5") === '"total -5"');

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
