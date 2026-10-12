/**
 * Store-timezone converters for admin datetime-local fields — the fix for the
 * +1h schedule drift where a naked wall-clock was parsed in the container's
 * UTC runtime instead of Africa/Tunis. Pure, no DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/store-tz.test.ts
 */
import {
  parseStoreLocalDateTime,
  storeLocalDateTimeInput,
  tzOffsetMinutes,
} from "@/lib/time/store-tz";

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
  console.log("parseStoreLocalDateTime — wall-clock is Africa/Tunis (UTC+1):");
  // 09:00 Tunis is 08:00Z — NOT 09:00Z (the old `new Date(s)` bug in UTC prod).
  check(
    "09:00 Tunis -> 08:00Z",
    parseStoreLocalDateTime("2026-01-01T09:00")?.toISOString() === "2026-01-01T08:00:00.000Z",
  );
  check(
    "seconds preserved",
    parseStoreLocalDateTime("2026-06-15T14:30:45")?.toISOString() ===
      "2026-06-15T13:30:45.000Z",
  );
  // Midnight rolls the UTC date back a day.
  check(
    "00:00 Tunis -> previous-day 23:00Z",
    parseStoreLocalDateTime("2026-03-01T00:00")?.toISOString() === "2026-02-28T23:00:00.000Z",
  );
  check("blank -> null", parseStoreLocalDateTime("") === null);
  check("null -> null", parseStoreLocalDateTime(null) === null);
  check("garbage -> null", parseStoreLocalDateTime("not-a-date") === null);
  // A string that already carries an explicit zone is trusted as-is.
  check(
    "explicit Z is honoured, not shifted",
    parseStoreLocalDateTime("2026-01-01T09:00:00Z")?.toISOString() === "2026-01-01T09:00:00.000Z",
  );

  console.log("storeLocalDateTimeInput — instant -> Tunis wall-clock:");
  check(
    "08:00Z -> 09:00 Tunis",
    storeLocalDateTimeInput(new Date("2026-01-01T08:00:00Z")) === "2026-01-01T09:00",
  );
  check(
    "previous-day 23:00Z -> 00:00 next day Tunis",
    storeLocalDateTimeInput(new Date("2026-02-28T23:00:00Z")) === "2026-03-01T00:00",
  );
  check("blank -> empty string", storeLocalDateTimeInput(null) === "");
  check("invalid -> empty string", storeLocalDateTimeInput("nope") === "");

  console.log("round-trip — an operator's typed value survives unchanged:");
  for (const wall of ["2026-01-01T09:00", "2026-06-15T14:30", "2026-12-31T23:59", "2026-03-01T00:00"]) {
    const back = storeLocalDateTimeInput(parseStoreLocalDateTime(wall));
    check(`round-trip ${wall}`, back === wall);
  }

  console.log("tzOffsetMinutes — Tunis is +60 (no DST today):");
  check("winter +60", tzOffsetMinutes(new Date("2026-01-15T12:00:00Z")) === 60);
  check("summer +60", tzOffsetMinutes(new Date("2026-07-15T12:00:00Z")) === 60);

  // Drip-anchor date-only ROUND-TRIP (self-review regression guard): the product
  // form parses a "YYYY-MM-DD" field as store-local midnight on SAVE, and the
  // server renders the stored instant back via storeLocalDateTimeInput on READ;
  // slicing its first 10 chars must return the SAME store-local date — no day
  // drift. Rendering the instant as a UTC toISOString() (the old bug) returned
  // the previous calendar day for a Tunis-midnight instant, walking the anchor
  // back one day on every save.
  console.log("drip-anchor date-only round-trips store-local (no day drift):");
  {
    const stored = parseStoreLocalDateTime("2026-01-01T00:00"); // save path
    check("stored instant is Tunis midnight (2025-12-31T23:00Z)", stored?.toISOString() === "2025-12-31T23:00:00.000Z");
    check("read-back date-only field == the date the admin picked", storeLocalDateTimeInput(stored).slice(0, 10) === "2026-01-01");
    check("a UTC slice WOULD drift a day (proves the fix matters)", stored!.toISOString().slice(0, 10) === "2025-12-31");
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
