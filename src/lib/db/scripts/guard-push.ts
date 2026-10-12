/**
 * Guard for `pnpm db:push` (drizzle-kit push).
 *
 * `push` diffs the Drizzle schema barrel (src/lib/db/schema.ts) against the live DB and
 * applies the delta directly — with NO migration file and NO review. Two tables exist ONLY
 * as raw SQL in the baseline and are deliberately absent from the barrel — `app_secrets`
 * (the encrypted secrets store: PAYMENT_ENCRYPTION_KEY, erp.*, ai.* keys) and
 * `rate_limit_buckets` — plus the transient `tmp_*` import tables. Because they have no
 * pgTable() definition, `push` would otherwise compute `DROP TABLE app_secrets` /
 * `DROP TABLE rate_limit_buckets` and, if confirmed, silently destroy the dev secrets store.
 * drizzle.config.ts now ALSO carries a `tablesFilter` sparing these tables as a second
 * layer — but that filter is table-granular and can't protect the DB-only INDEXES on
 * barrelled tables (e.g. products_compare_at_idx), so `push` still refuses here by default.
 * Migrations here are hand-authored (see guard-generate.ts).
 *
 * Escape hatch (dev only, you accept the drop prompt yourself): `pnpm db:push:force`.
 */

console.error(
  [
    "",
    "  ✋  `pnpm db:push` is disabled on purpose.",
    "",
    "      `push` diffs the schema BARREL against the DB and applies it with no migration.",
    "      `app_secrets` + `rate_limit_buckets` (and the tmp_* import tables) live only as",
    "      raw SQL — absent from the barrel — so push would offer to DROP them (destroying",
    "      the encrypted secrets store). Migrations here are written BY HAND:",
    "",
    "        1. add  src/lib/db/migrations/NNNN_name.sql  (--> statement-breakpoint)",
    "        2. add  a matching entry in migrations/meta/_journal.json",
    "        3. update the Drizzle schema in src/modules/<m>/schema.ts",
    "        4. run  pnpm db:migrate",
    "",
    "      Docs: docs/database.md → Migrations.",
    "      Override (dev only, you accept the DROP prompts): pnpm db:push:force",
    "",
  ].join("\n"),
);
process.exit(1);
