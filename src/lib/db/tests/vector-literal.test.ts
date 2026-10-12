/**
 * PURE unit test for the pgvector literal guard (`toVectorLiteral`). No DB, no
 * server-only — runs in the `test:pure` chain.
 *
 *   npx tsx --conditions=react-server src/lib/db/tests/vector-literal.test.ts
 *
 * WHY THIS MATTERS: `searchProducts` casts the returned string as `::vector`. If a
 * malformed embedding (empty / NaN / Infinity) ever produced a literal like
 * `[NaN]`, Postgres REJECTS the cast and throws INSIDE the product reader — every
 * product hit then silently vanishes from search. The guard must return null for
 * anything unusable so the caller falls back to the keyword-only query.
 */
import { toVectorLiteral } from "@/modules/search/vector";

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
  console.log("valid vectors → literal:");
  check("normal 3-vector → '[0.1,0.2,0.3]'", toVectorLiteral([0.1, 0.2, 0.3]) === "[0.1,0.2,0.3]");
  check("integers render without decimals", toVectorLiteral([1, 2, 3]) === "[1,2,3]");
  check("negatives + zero preserved", toVectorLiteral([-0.5, 0, 0.5]) === "[-0.5,0,0.5]");
  check("single-element vector", toVectorLiteral([0.42]) === "[0.42]");

  console.log("unusable vectors → null (fall back to keyword-only):");
  check("empty array → null", toVectorLiteral([]) === null);
  check("NaN component → null", toVectorLiteral([1, NaN, 3]) === null);
  check("+Infinity component → null", toVectorLiteral([1, Infinity]) === null);
  check("-Infinity component → null", toVectorLiteral([-Infinity, 2]) === null);
  // Non-number members can arrive via untyped JSON; treat the whole vector as unusable.
  check(
    "non-number member → null",
    toVectorLiteral([1, "2" as unknown as number, 3]) === null,
  );
  check("NaN-only vector → null", toVectorLiteral([NaN]) === null);
  check(
    "non-array input → null",
    toVectorLiteral(null as unknown as number[]) === null,
  );

  console.log("injection surface:");
  // Only finite numbers ever reach the literal, so there is no way to smuggle SQL —
  // any non-numeric content forces null above. Sanity-check the join is numbers-only.
  check(
    "literal contains only digits, sign, dot, comma, brackets",
    /^\[[-0-9.,]*\]$/.test(toVectorLiteral([1, -2.5, 3.14]) ?? "x"),
  );

  console.log(`\nvector-literal.test.ts — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main();
