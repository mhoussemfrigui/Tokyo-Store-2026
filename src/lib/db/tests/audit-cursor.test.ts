/**
 * Pure audit keyset-cursor helpers (src/modules/audit/cursor.ts). No DB.
 * The cursor is the row id (uuid v7) — locks the uuid validation (junk cursors
 * are ignored, never reach SQL) and the limit clamp.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/audit-cursor.test.ts
 */
import {
  clampAuditLimit,
  isValidAuditCursor,
  parseAuditCursor,
  parseAuditDateWindow,
  normalizeAuditFilters,
  AUDIT_LIST_MAX,
  AUDIT_LIST_DEFAULT,
} from "@/modules/audit/cursor";

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

const VALID = "0192f3a4-5b6c-7d8e-9f01-23456789abcd";

function main() {
  console.log("isValidAuditCursor:");
  check("accepts a uuid", isValidAuditCursor(VALID));
  check("accepts upper-case uuid", isValidAuditCursor(VALID.toUpperCase()));
  check("rejects null", !isValidAuditCursor(null));
  check("rejects empty", !isValidAuditCursor(""));
  check("rejects an ISO timestamp (old cursor format)", !isValidAuditCursor("2026-06-22T10:00:00.000Z"));
  check("rejects junk", !isValidAuditCursor("'; DROP TABLE audit_log; --"));
  check("rejects almost-uuid (wrong length)", !isValidAuditCursor("0192f3a4-5b6c-7d8e-9f01"));

  console.log("parseAuditCursor:");
  check("returns the uuid when valid", parseAuditCursor(VALID) === VALID);
  check("returns null for junk", parseAuditCursor("nope") === null);
  check("returns null for undefined", parseAuditCursor(undefined) === null);

  console.log("clampAuditLimit:");
  check("default when undefined", clampAuditLimit(undefined) === AUDIT_LIST_DEFAULT);
  check("default when NaN", clampAuditLimit(Number.NaN) === AUDIT_LIST_DEFAULT);
  check("caps at MAX", clampAuditLimit(10_000) === AUDIT_LIST_MAX);
  check("floors at 1", clampAuditLimit(0) === 1);
  check("floors negative at 1", clampAuditLimit(-5) === 1);
  check("passes a normal value", clampAuditLimit(25) === 25);
  check("floors a fractional value", clampAuditLimit(25.9) === 25);

  console.log("parseAuditDateWindow:");
  check("empty → no bounds", (() => {
    const w = parseAuditDateWindow(undefined, undefined);
    return w.from === undefined && w.to === undefined;
  })());
  // Days are STORE-local (Africa/Tunis, UTC+1): 2026-06-01 starts at 23:00Z
  // the day before — not UTC midnight, which ran the day 01:00→00:59 Tunis.
  check("from parsed to the store day's start (00:00 Tunis = 23:00Z prev day)", (() => {
    const w = parseAuditDateWindow("2026-06-01", undefined);
    return w.from?.toISOString() === "2026-05-31T23:00:00.000Z";
  })());
  check("to expanded to the store day's inclusive end (23:59:59.999 Tunis)", (() => {
    const w = parseAuditDateWindow(undefined, "2026-06-22");
    return w.to?.toISOString() === "2026-06-22T22:59:59.999Z";
  })());
  check("same-day from/to spans exactly one store day", (() => {
    const w = parseAuditDateWindow("2026-06-22", "2026-06-22");
    return !!w.from && !!w.to && w.to.getTime() - w.from.getTime() === 24 * 60 * 60 * 1000 - 1;
  })());
  check("00:30 Tunis on the 22nd (23:30Z on the 21st) falls inside the 22nd", (() => {
    const w = parseAuditDateWindow("2026-06-22", "2026-06-22");
    const t = Date.parse("2026-06-21T23:30:00.000Z");
    return !!w.from && !!w.to && t >= w.from.getTime() && t <= w.to.getTime();
  })());
  check("00:30 Tunis on the 23rd (23:30Z on the 22nd) falls outside the 22nd", (() => {
    const w = parseAuditDateWindow(undefined, "2026-06-22");
    return !!w.to && Date.parse("2026-06-22T23:30:00.000Z") > w.to.getTime();
  })());
  check("to on a month/year edge rolls to the next store day correctly", (() => {
    const w = parseAuditDateWindow(undefined, "2026-12-31");
    return w.to?.toISOString() === "2026-12-31T22:59:59.999Z";
  })());
  check("a non-existent day (2026-02-30) → undefined, not a rolled-over date", (() => {
    const w = parseAuditDateWindow("2026-02-30", "2026-02-30");
    return w.from === undefined && w.to === undefined;
  })());
  check("a naked wall-clock is store-local and exact (no day expansion)", (() => {
    const w = parseAuditDateWindow("2026-06-22T10:00", "2026-06-22T12:00");
    return (
      w.from?.toISOString() === "2026-06-22T09:00:00.000Z" &&
      w.to?.toISOString() === "2026-06-22T11:00:00.000Z"
    );
  })());
  check("an ISO instant with a zone is taken as-is", (() => {
    const w = parseAuditDateWindow("2026-06-22T10:00:00.000Z", undefined);
    return w.from?.toISOString() === "2026-06-22T10:00:00.000Z";
  })());
  check("blank strings → undefined", (() => {
    const w = parseAuditDateWindow("  ", "");
    return w.from === undefined && w.to === undefined;
  })());
  check("invalid date → undefined", (() => {
    const w = parseAuditDateWindow("not-a-date", "also-bad");
    return w.from === undefined && w.to === undefined;
  })());

  console.log("normalizeAuditFilters:");
  check("remaps event→eventName, actor→actorUserId", (() => {
    const f = normalizeAuditFilters({ event: "product.updated", actor: "u1" });
    return f.eventName === "product.updated" && f.actorUserId === "u1";
  })());
  check("trims + drops blank fields", (() => {
    const f = normalizeAuditFilters({ event: "  ", domain: " order ", severity: "" });
    return f.eventName === undefined && f.domain === "order" && f.severity === undefined;
  })());
  check("from/to are store-local days, to inclusive end-of-day", (() => {
    const f = normalizeAuditFilters({ from: "2026-06-22", to: "2026-06-22" });
    return (
      f.from?.toISOString() === "2026-06-21T23:00:00.000Z" &&
      f.to?.toISOString() === "2026-06-22T22:59:59.999Z"
    );
  })());
  check("empty input → all undefined", (() => {
    const f = normalizeAuditFilters({});
    return Object.values(f).every((v) => v === undefined);
  })());

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
