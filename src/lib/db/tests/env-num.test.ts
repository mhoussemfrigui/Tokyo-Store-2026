/**
 * Pure env-number parsing (src/lib/db/env-num.ts). No DB, no server-only.
 * Guards the blank-Coolify-env footgun: Number("") === 0 must NOT pass through
 * as a real value (it would have set pool max = 0 / statement_timeout = 0).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/env-num.test.ts
 */
import { posIntEnv } from "@/lib/db/env-num";

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
  console.log("posIntEnv — fallbacks (anything not a real positive number):");
  check("undefined → fallback", posIntEnv(undefined, 12) === 12);
  check("empty string → fallback", posIntEnv("", 12) === 12);
  check("whitespace-only → fallback", posIntEnv("   ", 12) === 12);
  check("non-numeric → fallback", posIntEnv("abc", 12) === 12);
  check("zero → fallback (the critical case)", posIntEnv("0", 12) === 12);
  check("negative → fallback", posIntEnv("-5", 12) === 12);
  check("NaN literal → fallback", posIntEnv("NaN", 12) === 12);
  check("Infinity → fallback (not finite)", posIntEnv("Infinity", 12) === 12);

  console.log("posIntEnv — real values pass through:");
  check("plain integer", posIntEnv("24", 12) === 24);
  check("integer with surrounding whitespace", posIntEnv("  48  ", 12) === 48);
  check("large value", posIntEnv("10000", 12) === 10000);
  // It only guarantees a positive, finite number — fractional inputs are passed
  // through as-is (callers feed integers); documents the (intentional) behaviour.
  check("positive float passes through", posIntEnv("1.5", 12) === 1.5);
  check("value of 1 (boundary) passes through", posIntEnv("1", 12) === 1);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
