import "server-only";

/**
 * CSV export field-selection helper (lib/csv/fields.ts) — the operator-picks-columns
 * logic shared by every admin export. Pure. Run:
 *   tsx --conditions=react-server src/lib/db/tests/export-fields.test.ts
 */
import { selectCsvFields, csvHeaderLine, csvRowLine, fieldChoices, type CsvField } from "@/lib/csv/fields";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

type Row = { a: string; b: number; c: string | null };
const FIELDS: CsvField<Row>[] = [
  { key: "a", label: "Col A", value: (r) => r.a },
  { key: "b", label: "Col B", value: (r) => r.b },
  { key: "c", label: "Col C", value: (r) => r.c },
];
const keys = (fs: CsvField<Row>[]) => fs.map((f) => f.key).join(",");

// selectCsvFields — ordered subset, unknown dropped, dedup, fallback to all.
check("subset honours the REQUESTED order", keys(selectCsvFields(FIELDS, "b,a")) === "b,a");
check("unknown key is dropped", keys(selectCsvFields(FIELDS, "a,zzz,b")) === "a,b");
check("duplicate key collapsed", keys(selectCsvFields(FIELDS, "a,a,b")) === "a,b");
check("empty selection → full catalog", keys(selectCsvFields(FIELDS, "")) === "a,b,c");
check("null selection → full catalog", keys(selectCsvFields(FIELDS, null)) === "a,b,c");
check("all-invalid selection → full catalog", keys(selectCsvFields(FIELDS, "x,y")) === "a,b,c");
check("whitespace tolerated", keys(selectCsvFields(FIELDS, " b , a ")) === "b,a");

// header + row rendering (labels as header, accessors per row). csvCell always
// RFC-4180-quotes, so each cell is wrapped in double quotes.
check("header uses labels of the chosen fields", csvHeaderLine(selectCsvFields(FIELDS, "b,a")) === '"Col B","Col A"');
check("row renders chosen values in order", csvRowLine(selectCsvFields(FIELDS, "b,a"), { a: "hi", b: 7, c: null }) === '"7","hi"');
check("null value renders as empty (quoted) cell", csvRowLine(selectCsvFields(FIELDS, "c"), { a: "x", b: 0, c: null }) === '""');

// csvCell escaping still applies (formula-injection / comma safety) through the helper.
const injected = csvRowLine([{ key: "x", label: "X", value: (r: { x: string }) => r.x }], { x: "=SUM(A1)" });
check("a cell starting with = is neutralised (quoted/prefixed)", injected !== "=SUM(A1)");

// fieldChoices strips accessors for the client picker.
check("fieldChoices returns {key,label} only", JSON.stringify(fieldChoices(FIELDS)) === JSON.stringify([
  { key: "a", label: "Col A" },
  { key: "b", label: "Col B" },
  { key: "c", label: "Col C" },
]));

console.log(`\n=== export-fields: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
