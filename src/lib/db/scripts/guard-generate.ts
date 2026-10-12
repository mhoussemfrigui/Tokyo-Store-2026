/**
 * Guard for `pnpm db:generate` (drizzle-kit generate).
 *
 * The Drizzle meta-snapshot chain under `src/lib/db/migrations/meta` is
 * intentionally FROZEN at `0007_snapshot.json`. Every migration since (0008–) has
 * been hand-authored SQL with a matching `_journal.json` entry but NO snapshot.
 * `drizzle-kit generate` diffs the live schema against the last *snapshot* — i.e.
 * the 0007 state — so running it here would emit a massively DESTRUCTIVE migration
 * that drops everything added since 0007. That is a footgun, so this command
 * refuses by default.
 *
 * How to add a migration instead (the supported path):
 *   1. Write `src/lib/db/migrations/NNNN_name.sql` (statements separated by
 *      `--> statement-breakpoint`; prefer idempotent `IF [NOT] EXISTS` / guarded
 *      `DO $$ … $$`).
 *   2. Add a matching entry to `src/lib/db/migrations/meta/_journal.json`
 *      (`idx`, `version: "7"`, `when`, `tag` = filename without `.sql`).
 *   3. Update the relevant Drizzle schema in `src/modules/<m>/schema.ts` so it
 *      stays the source of truth.
 *   4. `pnpm db:migrate`.
 *   See docs/database.md → "Migrations".
 *
 * Escape hatch: if you have deliberately rebuilt the snapshot chain and really
 * want drizzle-kit to (re)generate, run `pnpm db:generate:force`.
 */

console.error(
  [
    "",
    "  ✋  `pnpm db:generate` is disabled on purpose.",
    "",
    "      The Drizzle meta-snapshot chain is frozen at 0007, so `generate` would",
    "      diff against that stale state and emit a DESTRUCTIVE migration (dropping",
    "      everything added since). Migrations here are written BY HAND:",
    "",
    "        1. add  src/lib/db/migrations/NNNN_name.sql  (--> statement-breakpoint)",
    "        2. add  a matching entry in migrations/meta/_journal.json",
    "        3. update the Drizzle schema in src/modules/<m>/schema.ts",
    "        4. run  pnpm db:migrate",
    "",
    "      Docs: docs/database.md → Migrations.",
    "      Override (only if you rebuilt the snapshots): pnpm db:generate:force",
    "",
  ].join("\n"),
);
process.exit(1);
