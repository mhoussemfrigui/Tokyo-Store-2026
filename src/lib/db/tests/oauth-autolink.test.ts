import "server-only";

/**
 * OAuth auto-link setting — the data layer behind the Google-link gate
 * (`account.create.before` in src/lib/auth/server.ts). Verifies:
 *   - a fresh user defaults to oauth_autolink = TRUE (ON by default since 0157;
 *     the gate still refuses the silent link for a 2FA account, so this is safe);
 *   - setOauthAutolink round-trips (the user can still turn it OFF);
 *   - userHasCredentialAccount distinguishes a password user (gated) from a
 *     pure-OAuth user (a fresh social sign-up — not gated).
 * Self-cleaning (`__oatest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/oauth-autolink.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { users, accounts } from "@/modules/auth/schema";
import { authService } from "@/modules/auth/service";

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

async function cleanup() {
  await db.execute(sql`DELETE FROM accounts WHERE user_id LIKE '__oatest%'`);
  await db.execute(sql`DELETE FROM users WHERE id LIKE '__oatest%'`);
}

async function main() {
  await cleanup();

  // A password user (has a `credential` account).
  const pwId = "__oatest-pw";
  await db.insert(users).values({ id: pwId, email: "__oatest-pw@example.test", name: "PW User" } as never);
  await db.insert(accounts).values({
    id: "__oatest-pw-acct",
    userId: pwId,
    accountId: pwId,
    providerId: "credential",
    password: "hash",
  } as never);

  // A pure-OAuth user (only a google account, no credential).
  const oaId = "__oatest-oauth";
  await db.insert(users).values({ id: oaId, email: "__oatest-oauth@example.test", name: "OAuth User" } as never);
  await db.insert(accounts).values({
    id: "__oatest-oauth-acct",
    userId: oaId,
    accountId: "g-123",
    providerId: "google",
  } as never);

  // 1) Default ON (0157) — the gate's 2FA carve-out keeps this safe.
  const pwUser = await authService.findById(pwId);
  check("fresh user defaults to oauth_autolink = true", pwUser?.oauthAutolink === true);

  // 2) Credential-account detection (the gate's auto-link-vs-fresh-signup split).
  check("password user HAS a credential account (→ gated)", (await authService.userHasCredentialAccount(pwId)) === true);
  check("pure-OAuth user has NO credential account (→ fresh sign-up, allowed)", (await authService.userHasCredentialAccount(oaId)) === false);

  // 3) Opt-in round-trips.
  await authService.setOauthAutolink(pwId, true);
  check("setOauthAutolink(true) persists", (await authService.findById(pwId))?.oauthAutolink === true);
  await authService.setOauthAutolink(pwId, false);
  check("setOauthAutolink(false) persists", (await authService.findById(pwId))?.oauthAutolink === false);

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
