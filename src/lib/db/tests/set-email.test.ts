import "server-only";

/**
 * Admin « set a user's login email » workflow (auth.set_email), against a live DB.
 * Backs the Entreprises member-account tools. Pins:
 *   - a valid change updates the email + marks it UNVERIFIED,
 *   - re-sending the current address is a no-op (ok, no write),
 *   - an address already used by ANOTHER account is refused (conflict),
 *   - malformed input is a validation error, a missing user is not_found.
 * (The rank guard is shared with set_password; a plain-customer target carries no
 * elevated perms, so any actor outranks it — that path stays open here.)
 *
 * Self-cleaning (`__setemail…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/set-email.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { workflows } from "@/workflows";
import { authService } from "@/modules/auth/service";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const TAG = "__setemail";
const ACTOR = `${TAG}-actor`;

async function cleanup() {
  await db.execute(sql`delete from "sessions" where "user_id" like ${TAG + "%"}`);
  await db.execute(sql`delete from "users" where id like ${TAG + "%"}`);
}

async function main() {
  await cleanup();

  await authService.insert({ id: ACTOR, email: `${ACTOR}@x.test`, name: ACTOR, role: "customer" } as never);
  await authService.insert({ id: `${TAG}-target`, email: `${TAG}-target@x.test`, name: "T", role: "customer", emailVerified: true } as never);
  await authService.insert({ id: `${TAG}-other`, email: `${TAG}-other@x.test`, name: "O", role: "customer" } as never);

  // ── valid change → email updated + unverified ──
  const r1 = await workflows.auth.setEmail({ userId: `${TAG}-target`, newEmail: `${TAG}-NEW@x.test` }, { actorUserId: ACTOR });
  check("valid change → ok", r1.ok === true);
  const t1 = await authService.findById(`${TAG}-target`);
  check("email persisted, lowercased", t1?.email === `${TAG}-new@x.test`.toLowerCase());
  check("new email marked UNVERIFIED", t1?.emailVerified === false);

  // ── no-op: re-send the current address ──
  const r2 = await workflows.auth.setEmail({ userId: `${TAG}-target`, newEmail: `${TAG}-new@x.test` }, { actorUserId: ACTOR });
  check("re-sending the current address → ok (no-op)", r2.ok === true);

  // ── uniqueness: another account's address is refused ──
  const r3 = await workflows.auth.setEmail({ userId: `${TAG}-target`, newEmail: `${TAG}-other@x.test` }, { actorUserId: ACTOR });
  check("email already used by another account → conflict", !r3.ok && r3.error === "conflict");
  check("conflict did NOT change the target", (await authService.findById(`${TAG}-target`))?.email === `${TAG}-new@x.test`);

  // ── validation + not_found ──
  const r4 = await workflows.auth.setEmail({ userId: `${TAG}-target`, newEmail: "not-an-email" }, { actorUserId: ACTOR });
  check("malformed email → validation", !r4.ok && r4.error === "validation");
  const r5 = await workflows.auth.setEmail({ userId: `${TAG}-ghost`, newEmail: `${TAG}-z@x.test` }, { actorUserId: ACTOR });
  check("missing user → not_found", !r5.ok && r5.error === "not_found");

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try { await cleanup(); } catch { /* best-effort */ }
    process.exit(1);
  })
  .then(() => process.exit(0));
