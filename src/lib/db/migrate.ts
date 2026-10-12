/**
 * Applies pending migrations to the database.
 *
 *   pnpm db:migrate                      # local dev (via tsx)
 *   node db-runner/migrate.cjs           # inside the Docker runtime image
 *
 * Idempotent — re-running is safe. Drizzle keeps its own ledger in
 * `drizzle.__migrations` so already-applied SQL is skipped.
 *
 * This file:
 *   - Does NOT use the `@/*` path alias (so it works under bare Node).
 *   - Does NOT use `import.meta.url` (so it survives esbuild's CJS bundling
 *     for the runtime image, where `import.meta.url` is undefined).
 *   - Locates the migrations folder relative to `process.argv[1]` (the
 *     script's own path) so it works in both dev and prod layouts.
 */

import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
// Relative import (not @/*) — this file runs under bare Node / esbuild CJS.
import { pgConnectionConfig } from "./ssl";
import { Pool, type PoolClient } from "pg";

// The migrator needs a DIRECT Postgres connection: its session advisory lock,
// session SETs and startup `options` overrides do NOT survive a transaction
// pooler (PgBouncer). MIGRATION_DATABASE_URL, when set, is used instead of
// DATABASE_URL so the app can move to the pooler while migrations stay direct
// (docker-compose.coolify.yml always sets it to postgres:5432). Unset/blank ⇒
// DATABASE_URL, exactly as before.
const MIGRATION_URL = process.env.MIGRATION_DATABASE_URL?.trim();
const URL_SOURCE = MIGRATION_URL ? "MIGRATION_DATABASE_URL" : "DATABASE_URL";
const DATABASE_URL = MIGRATION_URL || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌  DATABASE_URL (or MIGRATION_DATABASE_URL) is required");
  process.exit(1);
}

// TLS/certificate failures are configuration errors, not "Postgres still
// booting" — retrying them for 60s only buried the real cause under a
// misleading "did not accept connections" error.
const TLS_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);
function isTlsConfigError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null;
  return (
    Boolean(e?.code && TLS_ERROR_CODES.has(e.code)) ||
    /does not support SSL/i.test(e?.message ?? "")
  );
}

// Find migrations next to the script. argv[1] is always the entry file,
// regardless of whether we got here via tsx (./src/lib/db/migrate.ts) or
// the esbuild-bundled CJS in production (/app/db-runner/migrate.cjs).
const scriptDir = path.dirname(path.resolve(process.argv[1] ?? "."));
const migrationsFolder = path.join(scriptDir, "migrations");

// Cross-process advisory-lock key. Arbitrary 32-bit int; the value just
// needs to be stable across deploys so two app instances racing on boot
// pick the same lock. Coolify rolling redeploys / several app replicas can
// fire migrate concurrently; without this, the second runner can deadlock on
// an ALTER TABLE issued by the first. It is a SESSION lock, so it only
// serialises runners on a direct connection (see MIGRATION_DATABASE_URL).
const ADVISORY_LOCK_KEY = 72707468;

async function main() {
  // 2 connections: one for the advisory lock (held for the whole migration),
  // one for drizzle to actually run the SQL. Previously `max:1` deadlocked
  // because the lockClient hogged the single slot while migrate() waited.
  console.log(`[db] migrator connecting via ${URL_SOURCE}`);
  const pool = new Pool({
    // `{ connectionString, ssl }` — honours ?sslmode=require (Coolify-managed PG
    // enforces TLS), verifying the cert when DB_SSL_CA is set; the URL's sslmode
    // is stripped so pg can't silently discard that ssl object (see ./ssl).
    ...pgConnectionConfig(DATABASE_URL!),
    max: 2,
    // Migrations run under the app role, which now carries role-level
    // lock_timeout=3s / idle_in_transaction=30s defaults (migration 0117) — fine
    // for the runtime, but a large DDL/backfill migration may legitimately wait
    // longer for a lock or run long. Override those per-connection via the libpq
    // startup packet: generous lock wait, no statement cap, no idle-in-txn
    // reaper. Honoured on a DIRECT connection only — a transaction pooler ignores
    // them, which is why MIGRATION_DATABASE_URL must point at Postgres itself.
    // (The lockClient below also SETs these on its own session; this covers the
    // separate connection drizzle's migrate() acquires from the pool.)
    options:
      "-c lock_timeout=120000 -c statement_timeout=0 -c idle_in_transaction_session_timeout=0",
  });
  const db = drizzle(pool);

  // Wait for Postgres to ACCEPT connections before doing anything. On a Coolify
  // co-deploy the app container can start before the (restarting) Postgres is
  // ready → `connect ECONNREFUSED`. Without this, the first `pool.connect()`
  // throws → the entrypoint's `set -e` aborts the whole boot, forcing a full
  // container restart cycle (and risking the healthcheck). Retry the initial
  // connect for ~60s instead — mirrors the advisory-lock retry below.
  let lockClient: PoolClient | undefined;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      lockClient = await pool.connect();
      break;
    } catch (err) {
      if (isTlsConfigError(err)) {
        await pool.end().catch(() => {});
        throw new Error(
          `Postgres TLS handshake failed (${(err as { code?: string })?.code ?? (err as Error).message}) — ` +
            "check the URL's sslmode and DB_SSL_CA (see src/lib/db/ssl.ts); not retrying.",
          { cause: err },
        );
      }
      const code = (err as { code?: string })?.code ?? "conn error";
      console.log(`[db] Postgres not ready (${code}); retry ${attempt}/30 in 2s…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!lockClient) {
    await pool.end().catch(() => {});
    throw new Error("Postgres did not accept connections after 60s");
  }
  let acquired = false;
  try {
    // Set a server-side idle timeout so a hard-killed migrator's stale
    // connection gets reaped in 60s instead of lingering until pg's default
    // hours-long idle limit. Without this, a container kill mid-migration
    // leaves the advisory lock held — the next container start blocks
    // forever on pg_advisory_lock().
    await lockClient.query("SET idle_in_transaction_session_timeout = '60s'");
    await lockClient.query("SET lock_timeout = '120s'");
    console.log("[db] acquiring migration advisory lock…");
    // pg_try_advisory_lock in a retry loop — gives clearer logs than a
    // blocking pg_advisory_lock when something else holds it.
    for (let attempt = 1; attempt <= 30; attempt++) {
      const { rows } = await lockClient.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS ok",
        [ADVISORY_LOCK_KEY],
      );
      if (rows[0]?.ok) {
        acquired = true;
        break;
      }
      console.log(`[db] lock held by another process; retry ${attempt}/30 in 2s…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!acquired) {
      throw new Error(
        "Migration advisory lock could not be acquired after 60s. " +
          "Check pg_stat_activity for a stale connection holding lock " +
          ADVISORY_LOCK_KEY,
      );
    }
    console.log(`[db] applying migrations from ${migrationsFolder}…`);
    await migrate(db, { migrationsFolder });
    console.log("[db] migrations applied.");
  } finally {
    try {
      const { rows } = await lockClient.query<{ ok: boolean }>(
        "SELECT pg_advisory_unlock($1) AS ok",
        [ADVISORY_LOCK_KEY],
      );
      // A session lock we took can only fail to unlock when this "session" is
      // not one backend — i.e. the migrator is behind a transaction pooler and
      // the lock is now stranded on another pooled server connection.
      if (acquired && rows[0]?.ok === false) {
        console.warn(
          "[db] WARNING: the migration advisory lock was not held by this session at unlock — " +
            `the migrator appears to run through a transaction pooler (PgBouncer) via ${URL_SOURCE}. ` +
            "Point MIGRATION_DATABASE_URL at Postgres directly (postgres:5432).",
        );
      }
    } catch {
      /* swallow — server will release on disconnect */
    }
    lockClient.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[db] migration failed", err);
  process.exit(1);
});
