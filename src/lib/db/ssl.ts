import { readFileSync } from "node:fs";

/**
 * Build the `ssl` option for the pg driver from DATABASE_URL + optional
 * DB_SSL_CA. Shared by the runtime pool (client.ts), the migrator (migrate.ts),
 * and the secret bootstrapper (init-secrets.ts) so TLS behaviour can't drift.
 *
 *   - no `sslmode=require` in the URL        → undefined (plain; private network / localhost)
 *   - `sslmode=require` + DB_SSL_CA provided  → VERIFIED TLS { ca, rejectUnauthorized: true }
 *   - `sslmode=require` + no CA               → encrypted-but-unverified (legacy), with a
 *                                               loud one-time warning in production
 *   - `sslmode=verify-ca|verify-full` + no usable CA → FAIL CLOSED (throws at boot)
 *
 * The verify-* modes are an EXPLICIT operator request for certificate
 * verification, so silently downgrading them to unverified TLS (the old
 * behaviour) defeated the point and was MITM-susceptible while the operator
 * believed they were protected. Those modes now refuse to start without a usable
 * CA. Plain `sslmode=require` keeps the lenient warn-and-continue fallback.
 *
 * DB_SSL_CA accepts either a PEM literal (contains "BEGIN CERTIFICATE") or a
 * path to a PEM file on disk.
 *
 * Pool constructors must go through `pgConnectionConfig()` (below), NOT pass
 * `ssl: buildDbSsl(url)` next to the raw URL — pg lets the URL's sslmode
 * override the object, which silently dropped this whole config.
 */
let warned = false;

export function buildDbSsl(
  databaseUrl: string,
): { ca?: string; rejectUnauthorized: boolean } | undefined {
  const strict = /sslmode=(verify-ca|verify-full)/.test(databaseUrl);
  // Honour require + the stricter verify-ca / verify-full modes.
  if (!strict && !/sslmode=require/.test(databaseUrl)) return undefined;

  const ca = process.env.DB_SSL_CA?.trim();
  if (ca) {
    const pem = ca.includes("BEGIN CERTIFICATE") ? ca : safeReadFile(ca);
    if (pem) return { ca: pem, rejectUnauthorized: true };
    // DB_SSL_CA IS set but couldn't be read as a PEM (bad path / not a literal).
    if (strict) {
      throw new Error(
        "[db] sslmode=verify-ca/verify-full requires a readable DB_SSL_CA, but the value is " +
          "neither a PEM literal (BEGIN CERTIFICATE) nor a readable file path. Refusing to start " +
          "with UNVERIFIED TLS for a verify-* mode — fix DB_SSL_CA or downgrade sslmode to require.",
      );
    }
    // Warn distinctly — don't fall through to the misleading "not set" message.
    if (!warned) {
      warned = true;
      console.warn(
        "[db] DB_SSL_CA is set but could not be read as a PEM (the value lacks " +
          "BEGIN CERTIFICATE and is not a readable file path). Falling back to UNVERIFIED " +
          "TLS — fix the CA value/path to enable certificate verification.",
      );
    }
    return { rejectUnauthorized: false };
  }

  // No CA at all. verify-* must NOT silently downgrade — fail closed.
  if (strict) {
    throw new Error(
      "[db] sslmode=verify-ca/verify-full demands certificate verification, but DB_SSL_CA is not " +
        "set — that would silently downgrade to UNVERIFIED TLS (MITM-susceptible). Refusing to " +
        "start. Set DB_SSL_CA to a CA PEM (literal or file path), or use sslmode=require if " +
        "encrypted-but-unverified TLS is acceptable.",
    );
  }
  if (process.env.NODE_ENV === "production" && !warned) {
    warned = true;
    console.warn(
      "[db] sslmode=require but DB_SSL_CA is not set — the connection is encrypted but the " +
        "server certificate is NOT verified (MITM-susceptible). Set DB_SSL_CA to a CA PEM " +
        "(literal or file path) to enable certificate verification.",
    );
  }
  return { rejectUnauthorized: false };
}

function safeReadFile(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** The `ssl` object handed to the pg driver (see pgConnectionConfig). */
export type PgSslConfig = {
  ca?: string;
  rejectUnauthorized: boolean;
  checkServerIdentity?: () => undefined;
};

// URL params pg-connection-string turns into its OWN `ssl` value — which then
// REPLACES the explicit `ssl` option (see pgConnectionConfig).
const URL_SSL_MODE_PARAMS = new Set(["sslmode", "ssl", "uselibpqcompat"]);
// libpq file params (read from disk by pg-connection-string). When present the
// operator is driving TLS through the URL itself — left untouched.
const URL_SSL_FILE_PARAMS = new Set(["sslrootcert", "sslcert", "sslkey"]);

function paramKey(pair: string): string {
  const raw = pair.split("=", 1)[0] ?? "";
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/**
 * `{ connectionString, ssl }` for a pg Pool/Client — use this instead of passing
 * `connectionString: url, ssl: buildDbSsl(url)` side by side.
 *
 * WHY: pg (connection-parameters.js) does `Object.assign({}, config,
 * parse(connectionString))`, and pg-connection-string sets `ssl = {}` for ANY
 * `sslmode` in the URL (treating require/verify-ca as verify-full against Node's
 * built-in CAs). So with `?sslmode=require` the explicit `ssl` object — the
 * DB_SSL_CA pin, or the documented "encrypted, unverified" require mode — was
 * silently DISCARDED: a private/self-signed CA failed the boot, and DB_SSL_CA
 * never reached the driver. When buildDbSsl returns an object we therefore strip
 * the ssl-mode params from the URL (every other byte of the URL is kept as-is)
 * so the explicit object wins. No sslmode (plain) → URL and `ssl: undefined`
 * unchanged (pg then reads PGSSLMODE, as before).
 *
 * `sslmode=verify-ca` gets libpq semantics (chain verified against the CA,
 * hostname NOT checked); verify-full keeps Node's default hostname check.
 * A URL carrying libpq file params (sslrootcert/sslcert/sslkey) is passed
 * through untouched — that TLS config is the URL's own (use DB_SSL_CA instead).
 * Throws exactly when buildDbSsl throws (verify-* without a usable CA).
 */
export function pgConnectionConfig(databaseUrl: string): {
  connectionString: string;
  ssl: PgSslConfig | undefined;
} {
  const base = buildDbSsl(databaseUrl);
  if (!base) return { connectionString: databaseUrl, ssl: undefined };

  const ssl: PgSslConfig = /sslmode=verify-ca/.test(databaseUrl)
    ? { ...base, checkServerIdentity: () => undefined }
    : base;

  const q = databaseUrl.indexOf("?");
  if (q === -1) return { connectionString: databaseUrl, ssl };
  const pairs = databaseUrl.slice(q + 1).split("&");
  if (pairs.some((p) => URL_SSL_FILE_PARAMS.has(paramKey(p)))) {
    return { connectionString: databaseUrl, ssl };
  }
  const kept = pairs.filter((p) => p !== "" && !URL_SSL_MODE_PARAMS.has(paramKey(p)));
  const connectionString = databaseUrl.slice(0, q) + (kept.length ? `?${kept.join("&")}` : "");
  return { connectionString, ssl };
}

/**
 * Classify the DB-TLS posture for the Sécurité scorecard WITHOUT throwing (unlike
 * buildDbSsl, which fails closed for verify-* at boot). Mirrors buildDbSsl's CA
 * READABILITY check so the dashboard can't report "verified" for a CA that is set
 * but unreadable (which `require` silently downgrades to unverified TLS):
 *   - null                  → TLS not required (private network / localhost)
 *   - "verified"            → required AND a usable CA PEM resolves
 *   - "required-unverified" → required but no usable CA (encrypted, NOT verified)
 */
export function resolveDbSslPosture(
  databaseUrl: string,
): "verified" | "required-unverified" | null {
  if (!/sslmode=(require|verify-ca|verify-full)/.test(databaseUrl)) return null;
  const ca = process.env.DB_SSL_CA?.trim();
  if (ca) {
    const pem = ca.includes("BEGIN CERTIFICATE") ? ca : safeReadFile(ca);
    if (pem) return "verified";
  }
  return "required-unverified";
}
