/**
 * Pure security helpers from the Sécurité epic — maskEmail (security-event PII
 * masking), resolveDbSslPosture (the scorecard's DB-TLS verdict) and pgConnectionConfig
 * (the ssl object actually reaching the pg driver — asserted through a real,
 * never-connected pg Client). No DB, no server-only.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/security-helpers.test.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { Client } from "pg";

import { maskEmail } from "@/lib/email/util";
import { pgConnectionConfig, resolveDbSslPosture } from "@/lib/db/ssl";

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

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

function main() {
  console.log("maskEmail — keep first local char + full domain, '***' sentinel:");
  check("lowercases head AND domain", maskEmail("Mohamed@Gmail.com") === "m***@gmail.com");
  check("basic", maskEmail("a@b.co") === "a***@b.co");
  check("null → ***", maskEmail(null) === "***");
  check("undefined → ***", maskEmail(undefined) === "***");
  check("empty → ***", maskEmail("") === "***");
  check("no @ → ***", maskEmail("nope") === "***");
  check("leading @ (at===0) → ***", maskEmail("@x.com") === "***");
  check("trailing @ (at===len-1) → ***", maskEmail("a@") === "***");
  check("multiple @ keeps current behaviour", maskEmail("a@b@c.com") === "a***@b@c.com");
  check("only the first local char is kept", maskEmail("verylonglocalpart@d.com") === "v***@d.com");

  console.log("resolveDbSslPosture — mirrors the driver's CA-readability check:");
  withEnv("DB_SSL_CA", undefined, () => {
    check("no sslmode → null", resolveDbSslPosture("postgres://h/db") === null);
    check("require + no CA → required-unverified", resolveDbSslPosture("postgres://h/db?sslmode=require") === "required-unverified");
    check("verify-full + no CA → required-unverified", resolveDbSslPosture("postgres://h/db?sslmode=verify-full") === "required-unverified");
  });
  withEnv("DB_SSL_CA", "-----BEGIN CERTIFICATE-----\nMIIstub\n-----END CERTIFICATE-----", () => {
    check("require + PEM literal → verified", resolveDbSslPosture("postgres://h/db?sslmode=require") === "verified");
    check("verify-ca + PEM literal → verified", resolveDbSslPosture("postgres://h/db?sslmode=verify-ca") === "verified");
    check("no sslmode → null even with a CA", resolveDbSslPosture("postgres://h/db") === null);
  });
  withEnv("DB_SSL_CA", "/no/such/path/ca.pem", () => {
    check("require + unreadable path → required-unverified (the just-fixed bug)", resolveDbSslPosture("postgres://h/db?sslmode=require") === "required-unverified");
  });

  // require + a REAL readable PEM file → verified.
  const dir = mkdtempSync(join(tmpdir(), "gz-ssltest-"));
  const caPath = join(dir, "ca.pem");
  try {
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nMIIreadable\n-----END CERTIFICATE-----\n", "utf8");
    withEnv("DB_SSL_CA", caPath, () => {
      check("require + readable file path → verified", resolveDbSslPosture("postgres://h/db?sslmode=require") === "verified");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // pgConnectionConfig — what the pg DRIVER actually ends up with. pg merges
  // `parse(connectionString)` OVER the config and pg-connection-string sets
  // `ssl = {}` for any sslmode, so passing `ssl: buildDbSsl(url)` next to the
  // raw URL silently dropped the CA / the unverified-require mode. The driver's
  // resolved `connectionParameters.ssl` must equal the object we built.
  console.log("pgConnectionConfig — the explicit ssl object reaches the pg driver:");
  const PEM = "-----BEGIN CERTIFICATE-----\nMIIstub\n-----END CERTIFICATE-----";
  const driver = (url: string) => {
    const cfg = pgConnectionConfig(url);
    const c = new Client(cfg) as unknown as {
      connectionParameters: { ssl: unknown; host: string; user: string; password: string; database: string; port: number };
    };
    return { cfg, params: c.connectionParameters };
  };
  withEnv("PGSSLMODE", undefined, () => {
    withEnv("DB_SSL_CA", undefined, () => {
      const plain = "postgres://u:p@h:5432/db?application_name=x";
      const r0 = driver(plain);
      check("no sslmode → URL untouched", r0.cfg.connectionString === plain);
      check("no sslmode → ssl undefined (plain, as before)", r0.cfg.ssl === undefined);
      check("no sslmode → driver ssl stays falsy", !r0.params.ssl);

      const disable = "postgres://u:p@h/db?sslmode=disable";
      const rd = driver(disable);
      check("sslmode=disable → URL untouched", rd.cfg.connectionString === disable);
      check("sslmode=disable → driver ssl false", rd.params.ssl === false);

      const r1 = driver("postgres://u:p@h:5432/db?sslmode=require");
      check("require → sslmode stripped from the URL", r1.cfg.connectionString === "postgres://u:p@h:5432/db");
      check(
        "require + no CA → driver ssl is { rejectUnauthorized:false } (was {} = verify-full vs system CAs)",
        isDeepStrictEqual(r1.params.ssl, { rejectUnauthorized: false }),
      );
      check("require → host/port/db still parsed", r1.params.host === "h" && Number(r1.params.port) === 5432 && r1.params.database === "db");

      const r2 = driver("postgres://u:p@h/db?application_name=app&sslmode=require&ssl=true&connect_timeout=5");
      check(
        "only ssl-mode params are stripped; the others keep their order",
        r2.cfg.connectionString === "postgres://u:p@h/db?application_name=app&connect_timeout=5",
      );
      check("ssl=true alongside is stripped too (else ssl:true would win)", isDeepStrictEqual(r2.params.ssl, { rejectUnauthorized: false }));

      const r3 = driver("postgres://u:p%40ss%3Fw@h/db?sslmode=require");
      check("percent-encoded credentials kept byte-for-byte", r3.cfg.connectionString === "postgres://u:p%40ss%3Fw@h/db");
      check("…and still decode to the real password", r3.params.password === "p@ss?w" && r3.params.user === "u");

      let threw = false;
      try {
        pgConnectionConfig("postgres://h/db?sslmode=verify-full");
      } catch {
        threw = true;
      }
      check("verify-full + no CA still FAILS CLOSED (throws)", threw);
    });

    withEnv("DB_SSL_CA", PEM, () => {
      const r4 = driver("postgres://u:p@h/db?sslmode=require");
      check(
        "require + DB_SSL_CA → driver gets the CA pin { ca, rejectUnauthorized:true }",
        isDeepStrictEqual(r4.params.ssl, { ca: PEM, rejectUnauthorized: true }),
      );
      const r5 = driver("postgres://u:p@h/db?sslmode=verify-full");
      check(
        "verify-full + DB_SSL_CA → CA pin, default hostname check kept",
        isDeepStrictEqual(r5.params.ssl, { ca: PEM, rejectUnauthorized: true }),
      );
      const r6 = driver("postgres://u:p@h/db?sslmode=verify-ca");
      const s6 = r6.params.ssl as { ca?: string; rejectUnauthorized?: boolean; checkServerIdentity?: () => unknown };
      check(
        "verify-ca + DB_SSL_CA → CA pin + libpq verify-ca (no hostname check)",
        s6?.ca === PEM && s6.rejectUnauthorized === true && typeof s6.checkServerIdentity === "function" && s6.checkServerIdentity() === undefined,
      );
      check("verify-ca → URL stripped", r6.cfg.connectionString === "postgres://u:p@h/db");

      const withFile = "postgres://u:p@h/db?sslmode=require&sslrootcert=/etc/ssl/root.crt";
      const cfg7 = pgConnectionConfig(withFile);
      check("libpq file params (sslrootcert) → URL left untouched (URL-driven TLS)", cfg7.connectionString === withFile);
    });
  });

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
