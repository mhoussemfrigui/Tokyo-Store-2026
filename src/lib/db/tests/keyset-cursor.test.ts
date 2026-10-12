/**
 * PURE incremental-sync keyset helpers — NO database.
 *
 *  - `parseIncrementalCursor` (src/lib/api/cursor.ts): the `?since=` gate must
 *    reject CALENDAR-invalid dates that V8 silently rolls over (2025-02-30 →
 *    March 2) but Postgres refuses with 22008 — otherwise the raw-string
 *    `::timestamptz` cast 500s — and must pass a µs cursor through VERBATIM.
 *  - `keysetAfter` / `keysetCursor` / `settledBefore` (src/lib/api/keyset.ts):
 *    the cursor is bound as the RAW ISO string cast `::timestamptz` (never a
 *    ms-truncating JS Date), emitted µs-faithful via `to_char(… 'US')`, and the
 *    settle window holds back fresh rows unless explicitly disabled.
 *  - `foreseeableInputFail` maps 22007/22008 to a `validation` fail (400).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/keyset-cursor.test.ts
 */
import { PgDialect, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";

import { parseIncrementalCursor } from "@/lib/api/cursor";
import { KEYSET_SETTLE_SECONDS, keysetAfter, keysetCursor, settledBefore } from "@/lib/api/keyset";
import { foreseeableInputFail } from "@/workflows/shared";

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

const since = (v: string) => parseIncrementalCursor(new URLSearchParams({ since: v }));
const accepts = (v: string) => since(v).ok;

// ── parseIncrementalCursor: calendar + offset validation ─────────────────────
{
  console.log("parseIncrementalCursor — calendar-invalid dates → clean 400:");
  check("2025-02-30 rejected (V8 rolls it to 2025-03-02; Postgres 22008)", !accepts("2025-02-30"));
  check("2025-02-29 rejected (2025 is not a leap year)", !accepts("2025-02-29"));
  check("2025-04-31T10:00:00Z rejected (April has 30 days)", !accepts("2025-04-31T10:00:00Z"));
  check("2025-13-01 rejected (month 13)", !accepts("2025-13-01"));
  check("2025-00-10 rejected (month 0)", !accepts("2025-00-10"));
  check("2025-01-00 rejected (day 0)", !accepts("2025-01-00"));
  check("0000-01-01 rejected (year 0 — Postgres refuses it)", !accepts("0000-01-01"));
  check("offset +16:00 rejected (Postgres caps at ±15:59)", !accepts("2025-01-01T10:00:00+16:00"));
  check("25:00 rejected (Date gate)", !accepts("2025-01-01T25:00:00Z"));
  check("junk rejected", !accepts("not-a-date"));

  console.log("parseIncrementalCursor — valid inputs pass:");
  check("2024-02-29 accepted (leap year)", accepts("2024-02-29"));
  check("2025-12-31T23:59:59Z accepted", accepts("2025-12-31T23:59:59Z"));
  check("offset +01:00 accepted", accepts("2025-06-01T10:00:00+01:00"));
  check("offset -0500 accepted", accepts("2025-06-01T10:00:00-0500"));
  check("offset +14:00 accepted", accepts("2025-06-01T10:00:00+14:00"));
  const us = "2026-09-22T13:28:00.179113Z";
  const parsed = since(us);
  check("µs cursor accepted", parsed.ok);
  check("µs cursor passed through VERBATIM (no ms truncation)", parsed.ok && parsed.sinceIso === us);
}

// ── keyset SQL: raw-string ::timestamptz binding, µs cursor, settle window ───
{
  console.log("keyset helpers:");
  const t = pgTable("keyset_fixture", {
    id: uuid("id").primaryKey(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull(),
  });
  const dialect = new PgDialect();
  const ISO = "2026-09-22T13:28:00.179113Z";
  const ID = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";

  check("no sinceIso → no predicate", keysetAfter(t.created_at, t.id, undefined, ID) === undefined);

  const strict = keysetAfter(t.created_at, t.id, ISO, ID);
  const sq = strict ? dialect.sqlToQuery(strict) : null;
  check("strict-after predicate built", !!sq);
  check("strict: compares `>` then `=` + id tiebreak", !!sq && /> \$1::timestamptz OR \(.*= \$2::timestamptz AND .*> \$3::uuid\)/.test(sq.sql));
  check(
    "strict: since bound as the RAW ISO string (not a ms Date)",
    !!sq && sq.params[0] === ISO && sq.params[1] === ISO && typeof sq.params[0] === "string",
  );
  check("strict: sinceId bound", !!sq && sq.params[2] === ID);

  const bare = keysetAfter(t.created_at, t.id, ISO, undefined);
  const bq = bare ? dialect.sqlToQuery(bare) : null;
  check("bare since → inclusive `>=` watermark", !!bq && />= \$1::timestamptz/.test(bq.sql) && bq.params[0] === ISO);

  const cq = dialect.sqlToQuery(keysetCursor(t.created_at));
  check("cursor rendered in SQL at µs precision (to_char … US, UTC)", /to_char\(.* at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\)/.test(cq.sql));

  check("settle window defaults to KEYSET_SETTLE_SECONDS (> 0)", KEYSET_SETTLE_SECONDS > 0);
  const sw = settledBefore(t.created_at);
  const swq = sw ? dialect.sqlToQuery(sw) : null;
  check(
    "settle window: col < now() - make_interval(secs => N)",
    !!swq && /< now\(\) - make_interval\(secs => \$1\)/.test(swq.sql) && swq.params[0] === KEYSET_SETTLE_SECONDS,
  );
  check("settle window 0 → disabled (tests only)", settledBefore(t.created_at, 0) === undefined);
  check("settle window negative → disabled", settledBefore(t.created_at, -1) === undefined);
}

// ── foreseeableInputFail: bad dates → validation (400), never a 500 ──────────
{
  console.log("foreseeableInputFail — datetime errors:");
  const pgErr = (code: string) => Object.assign(new Error("pg"), { code });
  check("22008 (datetime overflow) → validation", foreseeableInputFail(pgErr("22008"))?.error === "validation");
  check("22007 (bad datetime format) → validation", foreseeableInputFail(pgErr("22007"))?.error === "validation");
  check(
    "22008 wrapped in .cause (drizzle) → validation",
    foreseeableInputFail(Object.assign(new Error("Failed query"), { cause: pgErr("22008") }))?.error === "validation",
  );
  check("22008 message is human (French)", /Date invalide/.test(foreseeableInputFail(pgErr("22008"))?.message ?? ""));
}

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
