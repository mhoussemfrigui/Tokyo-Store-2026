import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit configuration — used by:
 *   pnpm db:generate   → GUARDED (refuses by default): the meta-snapshot chain is
 *                        frozen at 0007, so generate would diff against stale state
 *                        and emit a destructive migration. Migrations are authored
 *                        by hand — see src/lib/db/scripts/guard-generate.ts and
 *                        docs/database.md. Escape hatch: pnpm db:generate:force.
 *   pnpm db:push       → push schema directly to DB (dev only, destructive)
 *   pnpm db:studio     → web UI at https://local.drizzle.studio
 *
 * Runtime migrations are applied by `src/lib/db/migrate.ts` (`pnpm db:migrate`).
 *
 * NOTE: we read DATABASE_URL directly here (not through the full Zod env
 * validator) so `db:generate` can run without all the other env vars set.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://tokyo:tokyo_dev_pwd@localhost:5434/tokyo";

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./src/lib/db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: DATABASE_URL,
  },
  // Defense-in-depth: even a raw `drizzle-kit push` (db:push:force, or a direct
  // `npx drizzle-kit push` that bypasses the guard-push.ts npm wrapper) must never
  // DROP the raw-SQL tables that live OUTSIDE the schema barrel — app_secrets
  // (encrypted secrets store) and rate_limit_buckets. Leading "*" preserves the
  // default (all tables); the "!" patterns subtract these. NOTE: table-granularity
  // only — this does NOT protect DB-only INDEXES on barrelled tables, so guard-push.ts
  // stays the authoritative protection.
  tablesFilter: ["*", "!app_secrets", "!rate_limit_buckets", "!tmp_*"],
  verbose: true,
  strict: true,
  casing: "snake_case",
});
