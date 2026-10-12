/**
 * PURE workflow error mappers (src/workflows/shared.ts) — NO database.
 *
 * The `workflow()` catch turns FORESEEABLE Postgres errors into structured
 * `fail()` results instead of a 500, which is exactly what keeps the external /
 * ERP API's error contract honest (a bad id → 400, a duplicate → 409, never an
 * opaque server error a client retries forever). Pin the three mappers +
 * cause-chain walking here so a refactor can't silently re-open the 500 hole.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/workflow-error-mapping.test.ts
 */
import {
  foreseeableInputFail,
  uniqueViolationFail,
  dbContentionFail,
} from "@/workflows/shared";

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

/** A Drizzle-style wrapper: top-level Error with NO code, real pg error on .cause. */
const wrap = (pg: object) => Object.assign(new Error("Failed query: …"), { cause: pg });
const pgErr = (code: string, extra: object = {}) => Object.assign(new Error("pg"), { code, ...extra });

// ── foreseeableInputFail: bad input → validation (400), never a 500 ─────────
{
  const badUuid = foreseeableInputFail(pgErr("22P02"));
  check("22P02 (bad uuid/number) → validation", badUuid?.ok === false && badUuid.error === "validation");

  const badRef = foreseeableInputFail(pgErr("23503"));
  check("23503 (missing FK reference) → validation", badRef?.ok === false && badRef.error === "validation");

  check("22P02 has a human message", !!foreseeableInputFail(pgErr("22P02"))?.message);

  // Cause-chain walking (Drizzle wraps the driver error).
  check("22P02 wrapped in .cause → validation", foreseeableInputFail(wrap(pgErr("22P02")))?.error === "validation");
  check("23503 deep (.cause.cause) → validation", foreseeableInputFail({ cause: { cause: pgErr("23503") } })?.error === "validation");

  // NOT this mapper's job — a 23505/plain error/null must fall through to null.
  check("23505 (unique) → null (handled elsewhere)", foreseeableInputFail(pgErr("23505")) === null);
  check("plain error → null", foreseeableInputFail(new Error("boom")) === null);
  check("null → null (no throw)", foreseeableInputFail(null) === null);
}

// ── uniqueViolationFail: 23505 → conflict (409), field-keyed when known ──────
{
  const known = uniqueViolationFail(pgErr("23505", { constraint: "products_sku_unique" }));
  check("23505 known constraint → conflict", known?.ok === false && known.error === "conflict");
  check("23505 known constraint → field-keyed", !!known && !!known.fieldErrors?.sku);

  const unknown = uniqueViolationFail(pgErr("23505", { constraint: "some_new_index" }));
  check("23505 unknown constraint → generic conflict (no field)", unknown?.error === "conflict" && !unknown.fieldErrors);

  check("23505 wrapped in .cause → conflict", uniqueViolationFail(wrap(pgErr("23505", { constraint: "brands_slug_unique" })))?.error === "conflict");
  check("non-23505 → null", uniqueViolationFail(pgErr("23514")) === null);
  check("null → null (no throw)", uniqueViolationFail(null) === null);
}

// ── dbContentionFail: contention/stock CHECK → conflict (409) ───────────────
{
  const stock = dbContentionFail(pgErr("23514", { constraint: "products_stock_qty_nonneg" }));
  check("23514 stock CHECK → conflict (Stock insuffisant)", stock?.ok === false && stock.error === "conflict");
  check("23514 stock CHECK → field-keyed stockQty", !!stock?.fieldErrors?.stockQty);

  check("40P01 (deadlock) → conflict", dbContentionFail(pgErr("40P01"))?.error === "conflict");
  check("55P03 (lock_timeout) → conflict", dbContentionFail(pgErr("55P03"))?.error === "conflict");

  // A 23514 on a NON-stock CHECK isn't the lost-race case — fall through.
  check("23514 non-stock CHECK → null", dbContentionFail(pgErr("23514", { constraint: "orders_total_positive" })) === null);
  check("unrelated code → null", dbContentionFail(pgErr("22P02")) === null);
  check("null → null (no throw)", dbContentionFail(null) === null);
}

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
