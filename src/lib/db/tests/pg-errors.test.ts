/**
 * Pure Postgres-error helpers (src/lib/db/pg-errors.ts) — the cause-walker that
 * lets the import H1 retry SEE a Drizzle-wrapped 23505 — plus the pure display
 * helper maskEmail (src/lib/format/mask-email.ts). No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/pg-errors.test.ts
 */
import { pgErrorCode, isUniqueViolation, pgErrorConstraint } from "@/lib/db/pg-errors";
import { maskEmail } from "@/lib/format/mask-email";

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
  // Mimic Drizzle's DrizzleQueryError: a wrapper Error whose message is
  // "Failed query: …" and whose .cause carries the real pg error (code +
  // constraint). The top-level error has NO code — the whole point of the walk.
  const drizzleWrapped = Object.assign(new Error("Failed query: insert into products ..."), {
    cause: Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "products_sku_unique",
    }),
  });

  console.log("pgErrorCode / isUniqueViolation — walk the .cause chain:");
  check("reads 23505 off .cause (top-level code undefined)", pgErrorCode(drizzleWrapped) === "23505");
  check("isUniqueViolation true for wrapped 23505", isUniqueViolation(drizzleWrapped) === true);
  check("top-level code still read", pgErrorCode(Object.assign(new Error(), { code: "23514" })) === "23514");
  check("deep nesting (cause.cause)", pgErrorCode({ cause: { cause: { code: "23505" } } }) === "23505");
  check("non-pg error → undefined", pgErrorCode(new Error("boom")) === undefined);
  check("23514 is NOT a unique violation", isUniqueViolation(Object.assign(new Error(), { code: "23514" })) === false);
  check("null → undefined (no throw)", pgErrorCode(null) === undefined);

  console.log("pgErrorConstraint:");
  check("reads constraint off .cause", pgErrorConstraint(drizzleWrapped) === "products_sku_unique");
  check("undefined when no constraint", pgErrorConstraint(Object.assign(new Error(), { code: "23505" })) === undefined);
  check("undefined for plain error", pgErrorConstraint(new Error("x")) === undefined);

  console.log("maskEmail:");
  check("masks local part to first char", maskEmail("houssem@gmail.com") === "h***@gmail.com");
  check("short local part", maskEmail("a@b.co") === "a***@b.co");
  check("no @ → '' (caller falls back)", maskEmail("nope") === "");
  check("empty → ''", maskEmail("") === "");
  check("leading @ → ''", maskEmail("@x.com") === "");

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
