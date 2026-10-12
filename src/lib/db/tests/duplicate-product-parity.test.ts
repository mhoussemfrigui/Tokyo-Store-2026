import "server-only";

/**
 * Column-parity guard between createProduct and duplicateProduct (rescan #10).
 *
 * duplicateProduct hand-copies ~35 product columns into a fresh insert, parallel
 * to createProduct's insert. This has ALREADY silently regressed twice (the
 * inline comments record min/max_purchase_qty and shared_variant_stock both
 * getting reset on the copy). This PURE static-source test (readFileSync + regex
 * the insert keys, same idiom as internal-api-catalog.test.ts) fails loudly the
 * moment a new column is added to one insert but not the other.
 *
 * The two key sets differ only by INTENTIONAL exclusions:
 *   - create-only : external_ref  (a copy is a fresh, unlinked product — it
 *                   does not inherit the source's ERP key).
 *   - duplicate-only: slug, currency  (the copy generates a fresh slug and
 *                   preserves the source currency; create derives these).
 *
 * Run: pnpm exec tsx --conditions=react-server src/lib/db/tests/duplicate-product-parity.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

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

/** Top-level keys of the `productService.insert({ … })` object in a workflow. */
function insertKeys(file: string): Set<string> {
  const src = readFileSync(path.join(process.cwd(), file), "utf8");
  const call = src.indexOf("productService.insert({");
  if (call < 0) throw new Error(`no productService.insert in ${file}`);
  const braceStart = src.indexOf("{", call);
  // Brace-count to the matching close so we bound the object exactly.
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error(`unbalanced insert object in ${file}`);
  const body = src.slice(braceStart + 1, end);
  const keys = new Set<string>();
  const re = /(?:^|\n)[ \t]*([a-z_][a-z0-9_]*):/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) keys.add(m[1]);
  return keys;
}

function main() {
  const create = insertKeys("src/workflows/catalog/create-product.ts");
  const dup = insertKeys("src/workflows/catalog/duplicate-product.ts");

  check("createProduct insert is non-trivial", create.size > 20);
  check("duplicateProduct insert is non-trivial", dup.size > 20);

  const CREATE_ONLY = new Set(["external_ref"]);
  const DUP_ONLY = new Set(["slug", "currency"]);

  const createExtra = [...create].filter((k) => !dup.has(k) && !CREATE_ONLY.has(k));
  const dupExtra = [...dup].filter((k) => !create.has(k) && !DUP_ONLY.has(k));

  check(
    `no create-insert column missing from duplicate${createExtra.length ? " → " + createExtra.join(", ") : ""}`,
    createExtra.length === 0,
  );
  check(
    `no duplicate-insert column missing from create${dupExtra.length ? " → " + dupExtra.join(", ") : ""}`,
    dupExtra.length === 0,
  );

  // Parity covers KEYS only — also pin that the copy never inherits the source's
  // physical on-hand units (phantom sellable stock under the new listing): a
  // verbatim `stock_qty: source.stock_qty` / `stockQty: v.stock_qty` regressed it.
  // (The DB behaviour itself is exercised in product-stock-editor.test.ts.)
  const dupSrc = readFileSync(path.join(process.cwd(), "src/workflows/catalog/duplicate-product.ts"), "utf8");
  check(
    "duplicate resets on-hand stock (no verbatim stock_qty copy, product or variant)",
    !/stock_qty:\s*source\.stock_qty\s*,/.test(dupSrc) && !/stockQty:\s*v\.stock_qty\s*,/.test(dupSrc),
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
