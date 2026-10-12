import "server-only";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool, type PoolConfig } from "pg";

import { serverEnv } from "@/lib/env";
import { posIntEnv } from "./env-num";
import { pgConnectionConfig } from "./ssl";
import * as schema from "./schema";

/**
 * Shared Postgres connection pool.
 *
 * One pool per Node process. The `globalThis` trick survives Next.js HMR
 * in development so we don't leak connections every time a file changes.
 *
 * Sizing strategy
 * ────────────────
 * Default Postgres `max_connections = 100`. We assume up to 4 Next.js
 * server instances (horizontal scale ceiling on a 4-vCPU box). Each pool
 * tops out at `POOL_MAX`, so we want 4 × POOL_MAX << 100 to leave room
 * for migrations, psql, pgwatch, and PgBouncer's own bookkeeping.
 *
 *   prod: 12 × 4 = 48 + headroom ≈ 50 free for ops
 *   dev:  5 × 1  = 5 + tools
 *
 * When PgBouncer is in front, this max becomes a *client-side* cap that
 * gets multiplexed onto a much smaller server pool — bump to 25-50.
 *
 * SSL
 * ───
 * Coolify-managed Postgres exposes TLS on the public proxy. `pgConnectionConfig`
 * honours the URL's `?sslmode=` (require/verify-* → TLS, certificate-verified
 * when DB_SSL_CA is set); without it the connection is plain — fine for
 * localhost dev and private-network deploys (see ./ssl).
 *
 * Statement timeout
 * ─────────────────
 * Enforced TWICE, both at 10s by default (DB_STATEMENT_TIMEOUT_MS): server-side
 * via the `statement_timeout` startup param (no role-level default exists — 0117
 * deliberately skips it) and CLIENT-side via node-postgres `query_timeout`, which
 * also covers the PgBouncer path where startup params are ignored. Because the
 * client-side abort applies to every query on this pool, a
 * `SET LOCAL statement_timeout` alone CANNOT lengthen a query (the client still
 * gives up at 10s with "Query read timeout" while the server keeps running it).
 * Legitimate long jobs must use `withLongStatement(ms, fn)` below instead.
 *
 * Application name
 * ────────────────
 * Shows up in `pg_stat_activity.application_name` — invaluable when
 * diagnosing "who's holding this lock?" in pg_stat_activity / pgwatch.
 */

const isProd = process.env.NODE_ENV === "production";

// posIntEnv (blank/NaN/≤0 → fallback) lives in ./env-num so it can be unit-tested
// without dragging in "server-only"/pg. See that file for the why (empty Coolify
// env → Number("") === 0 → it would have disabled pool max / statement_timeout).

// 4 app instances × 12 = 48 connections; PgBouncer can multiplex further.
const POOL_MAX = isProd ? posIntEnv(process.env.DB_POOL_MAX, 12) : 5;
const STATEMENT_TIMEOUT_MS = posIntEnv(process.env.DB_STATEMENT_TIMEOUT_MS, 10_000);
const APPLICATION_NAME = process.env.DB_APPLICATION_NAME?.trim() || "tokyostore-app";
// Idle + acquire timeouts are env-overridable (like the others) so the box can
// be tuned without a rebuild; defaults unchanged. Same blank-env hardening.
const IDLE_TIMEOUT_MS = posIntEnv(process.env.DB_IDLE_TIMEOUT_MS, 15_000);
const CONNECTION_TIMEOUT_MS = posIntEnv(process.env.DB_CONNECTION_TIMEOUT_MS, 3_000);
// TCP keepalive on pooled connections — keeps an idle connection from being
// silently dropped by a NAT/proxy idle cutoff (Coolify proxy in front of
// managed PG), avoiding a surprise reconnect stall on the next acquire. On by
// default; set DB_KEEPALIVE=false to disable.
const KEEPALIVE = process.env.DB_KEEPALIVE !== "false";

/**
 * Read-only snapshot of the pool sizing/timeout config — exported so the
 * Database diagnostics tab displays the REAL numbers (never a drifting copy).
 */
export const POOL_CONFIG = {
  max: POOL_MAX,
  idleTimeoutMs: IDLE_TIMEOUT_MS,
  connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
  statementTimeoutMs: STATEMENT_TIMEOUT_MS,
  applicationName: APPLICATION_NAME,
  keepAlive: KEEPALIVE,
} as const;

declare global {
  var __gz_pool: Pool | undefined;
}

/**
 * Connection options shared by the pool and `withLongStatement`'s dedicated
 * client: URL + TLS, app name, keepalive, timeouts and startup options.
 */
function connectionOptions() {
  return {
    // `{ connectionString, ssl }` — honours ?sslmode=require / verify-* in
    // DATABASE_URL, with certificate verification when DB_SSL_CA is provided,
    // and strips the URL's sslmode so pg can't discard the ssl object (./ssl).
    ...pgConnectionConfig(serverEnv.DATABASE_URL),
    application_name: APPLICATION_NAME,
    // Keep idle pooled connections alive through proxy/NAT idle cutoffs.
    keepAlive: KEEPALIVE,
    // Drizzle types accept any pg config object. statement_timeout is a real
    // server setting; query_timeout is node-postgres' client-side abort.
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS,
    // idle-in-transaction + lock_timeout are applied at connection STARTUP (the
    // `options` packet) rather than via a post-connect `SET` query — the latter
    // races the first pooled query on a fresh connection (pg8 logs the
    // DeprecationWarning "client is already executing a query"; pg9 will THROW).
    // Behind PgBouncer (transaction pooling) these keys are IGNORED — they are
    // listed in IGNORE_STARTUP_PARAMETERS so the connection is accepted — and the
    // same limits are enforced server-side by the ROLE-level defaults from
    // migration 0117 (lock_timeout=3s, idle_in_transaction_session_timeout=30s).
    options: "-c idle_in_transaction_session_timeout=30000 -c lock_timeout=3000",
  } satisfies PoolConfig;
}

function buildPool(): Pool {
  const pool = new Pool({
    ...connectionOptions(),
    max: POOL_MAX,
    // Drop idle clients aggressively (15s) so a quiet period frees up
    // connections for other app instances on a shared managed-PG plan —
    // the box has hit "too many clients" under laxer settings.
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    // Fail-fast on acquire so a request that can't get a client errors
    // back to the caller in ~3s instead of stacking up new client
    // requests behind it (which compounds the pressure).
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  });

  pool.on("error", (err) => {
    // Pool-level errors are rare but fatal-ish — surface them to logs.
    // Don't crash the process; pg will reconnect on the next acquire().
    console.error("[db] pool error", err);
  });

  return pool;
}

const pool = globalThis.__gz_pool ?? buildPool();

if (!isProd) {
  globalThis.__gz_pool = pool;
}

export const db = drizzle({ client: pool, schema, casing: "snake_case" });
export type DB = typeof db;

/**
 * Live pool gauges for the Database diagnostics tab. Process-local — reflects
 * THIS app instance's pool only (one pool per Node process).
 */
export function getPoolStats(): { total: number; idle: number; waiting: number; max: number } {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    max: POOL_MAX,
  };
}
/**
 * Type for transaction callback parameter. The `tx` passed to the callback by
 * `db.transaction(async (tx) => …)` is a `PgTransaction`, not a `NodePgDatabase`.
 *
 * Service methods that take an optional `txOrDb` arg should use `DbOrTx` so
 * callers can thread either the pool (`db`) or an in-flight transaction (`tx`)
 * through them. Without this union the transaction object fails to type-check
 * against `typeof db` (it's missing `$client`).
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbOrTx = DB | Tx;
export { schema };

/**
 * Run a LEGITIMATELY long job (bulk import, backfill, heavy report) with a
 * statement budget of `ms` instead of the pool-wide 10s.
 *
 * The pool's client-side `query_timeout` cannot be lifted per query through
 * Drizzle, so `fn` runs inside a transaction on a DEDICATED short-lived
 * connection (outside the pool) whose `query_timeout` + `statement_timeout` are
 * `ms`, and the transaction also does `SET LOCAL statement_timeout` (the only
 * form that survives PgBouncer transaction pooling). lock_timeout and
 * idle_in_transaction_session_timeout keep their defaults — keep slow non-DB
 * work (HTTP calls, AI) OUT of `fn`, or the 30s idle-in-transaction reaper
 * kills the session. One extra Postgres connection per call: reserve it for
 * rare, operator-triggered jobs, never per-request paths.
 */
export async function withLongStatement<T>(ms: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!Number.isInteger(ms) || ms <= 0) {
    throw new Error(`withLongStatement: ms must be a positive integer (got ${ms})`);
  }
  const client = new Client({
    ...connectionOptions(),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    statement_timeout: ms,
    query_timeout: ms,
  });
  client.on("error", (err) => console.error("[db] long-statement client error", err));
  await client.connect();
  try {
    const longDb = drizzle({ client, schema, casing: "snake_case" });
    return await longDb.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('statement_timeout', ${String(ms)}, true)`);
      return fn(tx);
    });
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Graceful shutdown — call from your process exit hook.
 * Coolify sends SIGTERM on redeploy; without this the pool may hold
 * connections open and prevent a clean handover.
 */
export async function closePool(): Promise<void> {
  try {
    await pool.end();
  } catch (err) {
    console.error("[db] error closing pool", err);
  }
}
