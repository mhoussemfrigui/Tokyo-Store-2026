/**
 * Migration-journal integrity (src/lib/db/migrations/meta/_journal.json).
 *
 * Migrations are HAND-AUTHORED here (SQL file + a journal entry with a
 * hand-picked `when`), and the drizzle migrator only compares each entry's
 * `when` against the NEWEST applied row: `if (!last || last.created_at <
 * migration.folderMillis) run`. So an entry whose `when` is <= the previous one
 * is SILENTLY SKIPPED on every already-migrated database (prod, the dev DB)
 * while a fresh/CI database applies it — the code then 42703/42P01s only where
 * it matters, or an index/CHECK/grant quietly never exists. A .sql file with no
 * entry is never applied anywhere. Nothing else guards this.
 *
 * Asserts: entries.length === .sql file count; idx contiguous from 0 and equal
 * to position; tag === the file name and its 4-digit prefix === idx; the file
 * set equals the tag set (no orphan, no missing, no duplicate); version "7" +
 * breakpoints true; `when` a safe integer and STRICTLY increasing (the
 * load-bearing check). Pure (reads files only, no DB).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/migration-journal.test.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };

const MIGRATIONS_DIR = join(process.cwd(), "src", "lib", "db", "migrations");
const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta", "_journal.json"), "utf8")) as {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};
const entries = journal.entries;
const sqlFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

/** Collect offending labels and emit ONE check (keeps the output readable). */
function all(label: string, offenders: string[]) {
  check(offenders.length === 0 ? label : `${label} — FAILS: ${offenders.slice(0, 10).join("; ")}`, offenders.length === 0);
}

function main() {
  console.log("journal header:");
  check(`dialect is postgresql (${journal.dialect})`, journal.dialect === "postgresql");
  check("has at least one entry", entries.length > 0);

  console.log("entries ↔ files:");
  check(
    `entries.length (${entries.length}) === .sql file count (${sqlFiles.length})`,
    entries.length === sqlFiles.length,
  );
  const tags = entries.map((e) => e.tag);
  const tagSet = new Set(tags);
  all("tags are unique", tags.filter((t, i) => tags.indexOf(t) !== i));
  const fileTags = new Set(sqlFiles.map((f) => f.replace(/\.sql$/, "")));
  all("every .sql file has a journal entry (else never applied anywhere)", [...fileTags].filter((t) => !tagSet.has(t)));
  all("every journal entry has its .sql file", tags.filter((t) => !fileTags.has(t)));
  all(
    "no empty migration file",
    tags.filter((t) => fileTags.has(t) && statSync(join(MIGRATIONS_DIR, `${t}.sql`)).size === 0),
  );

  console.log("per-entry shape:");
  all(
    "idx === position (contiguous from 0)",
    entries.flatMap((e, i) => (e.idx === i ? [] : [`position ${i} has idx ${e.idx}`])),
  );
  all(
    "tag is NNNN_snake_case",
    entries.flatMap((e) => (/^\d{4}_[a-z0-9_]+$/.test(e.tag) ? [] : [e.tag])),
  );
  all(
    "tag's 4-digit prefix === idx",
    entries.flatMap((e) => (e.tag.slice(0, 4) === String(e.idx).padStart(4, "0") ? [] : [`${e.tag} (idx ${e.idx})`])),
  );
  all("version === \"7\"", entries.flatMap((e) => (e.version === "7" ? [] : [`${e.tag}: ${e.version}`])));
  all("breakpoints === true", entries.flatMap((e) => (e.breakpoints === true ? [] : [e.tag])));
  all(
    "when is a positive safe integer (ms)",
    entries.flatMap((e) => (Number.isSafeInteger(e.when) && e.when > 0 ? [] : [`${e.tag}: ${e.when}`])),
  );

  console.log("ordering (drizzle skips an entry whose `when` <= the last applied one):");
  all(
    "when is STRICTLY increasing",
    entries.flatMap((e, i) =>
      i > 0 && !(e.when > entries[i - 1].when)
        ? [`${e.tag} when=${e.when} <= ${entries[i - 1].tag} when=${entries[i - 1].when}`]
        : [],
    ),
  );

  const last = entries.at(-1);
  if (last) console.log(`  (latest: ${last.tag}, when=${last.when} = ${new Date(last.when).toISOString()})`);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
