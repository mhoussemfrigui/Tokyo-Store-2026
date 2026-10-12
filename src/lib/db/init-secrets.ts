/**
 * Bootstraps runtime secrets on container start, so a fresh Coolify deploy
 * doesn't require `openssl rand` ceremony.
 *
 *   pnpm db:init-secrets                           # local — prints exports
 *   SECRETS="$(node db-runner/init-secrets.cjs)" || exit 1; eval "$SECRETS"
 *                                                  # entrypoint usage — capture
 *   first: a bare `eval "$(…)"` under `set -e` swallows a non-zero exit
 *   (eval of empty output returns 0) and boots the server without secrets.
 *
 * Behaviour per secret:
 *   1. If `process.env[KEY]` is already set → no-op (operator override wins).
 *   2. Else look up `app_secrets.value` in Postgres → if present, export it.
 *   3. Else generate a fresh value, persist to `app_secrets`, export it.
 *
 * ONE-SHOT secrets (ADMIN_BOOTSTRAP_TOKEN) differ:
 *   - the key PRESENT in the environment, even EMPTY, is an explicit operator
 *     override → nothing is loaded, generated or exported (empty = disabled);
 *   - once the door is burned (`app_secrets.ADMIN_BOOTSTRAP_CLOSED`, written by
 *     the app after the first admin exists — see src/lib/bootstrap/default-admin.ts)
 *     the token is neither loaded nor regenerated, and any leftover row is
 *     deleted, so no live bootstrap credential survives in env, logs or backups.
 *
 * stdout: shell-format `export KEY='value'` lines (one per generated key).
 * stderr: human-readable log messages (do NOT log secret VALUES here except
 *         for ADMIN_BOOTSTRAP_TOKEN, which the operator needs once at setup).
 *
 * Bundled into `db-runner/init-secrets.cjs` by the Dockerfile (esbuild,
 * format=cjs, target=node22, external pg-native — same recipe as migrate.cjs).
 */

import { randomBytes } from "node:crypto";
import { Pool } from "pg";
// Relative import (not @/*) — this file runs under bare Node / esbuild CJS.
import { pgConnectionConfig } from "./ssl";

// Same DIRECT-connection preference as the boot migrator (migrate.ts): use
// MIGRATION_DATABASE_URL when set, else DATABASE_URL (unchanged behaviour).
const DATABASE_URL = process.env.MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("[init-secrets] DATABASE_URL (or MIGRATION_DATABASE_URL) is required");
  process.exit(1);
}

type SecretDef = {
  /** Env var name. */
  key: string;
  /** How to generate a fresh value when neither env nor DB has one. */
  generate: () => string;
  /**
   * When true, the generated value is printed to stderr ONCE so the
   * operator can copy it (e.g. for the admin bootstrap curl). Never set
   * true for long-lived cryptographic secrets — they should be retrieved
   * from the DB or set explicitly in env.
   */
  echoOnGenerate: boolean;
  /** One-line description for the log. */
  description: string;
  /**
   * One-shot secret (the admin bootstrap token): an env key that is PRESENT —
   * even empty — is an explicit override (empty = disabled, nothing exported),
   * and nothing is loaded/generated once `closedFlagKey` exists in app_secrets.
   */
  oneShot?: { closedFlagKey: string };
};

const SECRETS: readonly SecretDef[] = [
  {
    key: "BETTER_AUTH_SECRET",
    generate: () => randomBytes(32).toString("base64"),
    echoOnGenerate: false,
    description: "Better Auth session token signing key (32 bytes)",
  },
  {
    key: "PAYMENT_ENCRYPTION_KEY",
    generate: () => randomBytes(32).toString("base64"),
    echoOnGenerate: false,
    description: "AES-256-GCM key for payment credentials at rest (32 bytes)",
  },
  {
    key: "ADMIN_BOOTSTRAP_TOKEN",
    generate: () => randomBytes(24).toString("hex"),
    echoOnGenerate: true,
    description: "One-shot admin bootstrap token — burned once an admin exists",
    // Must match ADMIN_BOOTSTRAP_CLOSED_KEY in src/lib/bootstrap/default-admin.ts
    // (not imported: this file runs under bare Node / esbuild CJS).
    oneShot: { closedFlagKey: "ADMIN_BOOTSTRAP_CLOSED" },
  },
];

function shellEscape(value: string): string {
  // Single-quote and escape any embedded single quotes for shell-safe eval.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function main() {
  const pool = new Pool({
    // `{ connectionString, ssl }` — sslmode stripped from the URL when an
    // explicit ssl object applies, so pg can't discard it (see ./ssl).
    ...pgConnectionConfig(DATABASE_URL!),
    max: 1,
  });

  try {
    // Defensive: the baseline migration creates this table, but a brand-new
    // deploy may invoke this script before migrate.cjs has run. Create here too.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_secrets (
        key text PRIMARY KEY,
        value text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);

    for (const def of SECRETS) {
      // Operator override — env always wins, do nothing.
      if (process.env[def.key]) {
        console.error(`[init-secrets] ${def.key}: using env var (skipped DB)`);
        continue;
      }

      if (def.oneShot) {
        // An explicitly-set EMPTY value disables the one-shot secret: export
        // nothing, so the persisted DB value can't override the operator.
        if (def.key in process.env) {
          console.error(`[init-secrets] ${def.key}: explicitly empty in env — disabled (skipped DB)`);
          continue;
        }
        const closed = await pool.query(
          "SELECT 1 FROM app_secrets WHERE key = $1",
          [def.oneShot.closedFlagKey],
        );
        if (closed.rows.length > 0) {
          // Burned: drop any leftover persisted value and export nothing.
          await pool.query("DELETE FROM app_secrets WHERE key = $1", [def.key]);
          console.error(`[init-secrets] ${def.key}: closed (${def.oneShot.closedFlagKey}) — not exported`);
          continue;
        }
      }

      // Look up persisted value.
      const { rows } = await pool.query<{ value: string }>(
        "SELECT value FROM app_secrets WHERE key = $1",
        [def.key],
      );

      let value = rows[0]?.value;
      let generated = false;

      if (!value) {
        value = def.generate();
        generated = true;
        // Use INSERT ... ON CONFLICT so racing container starts don't crash.
        await pool.query(
          "INSERT INTO app_secrets (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
          [def.key, value],
        );
        // Re-read to make sure we use whatever value ultimately won the race.
        const reread = await pool.query<{ value: string }>(
          "SELECT value FROM app_secrets WHERE key = $1",
          [def.key],
        );
        value = reread.rows[0]?.value ?? value;
      }

      console.error(
        `[init-secrets] ${def.key}: ${
          generated ? "generated + persisted" : "loaded from app_secrets"
        }  (${def.description})`,
      );

      if (generated && def.echoOnGenerate) {
        console.error(
          `[init-secrets]   value: ${value}\n` +
            `[init-secrets]   use ONCE to bootstrap your first admin — it is burned ` +
            `automatically as soon as an admin exists (default admin or first bootstrap).`,
        );
      }

      // Print export to stdout for `eval` capture by the entrypoint.
      process.stdout.write(`export ${def.key}=${shellEscape(value)}\n`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[init-secrets] failed", err);
  process.exit(1);
});
