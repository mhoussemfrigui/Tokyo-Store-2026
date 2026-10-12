import "server-only";

/**
 * Mailing — newsletter→profile re-consent sync regression test. An explicit
 * newsletter (re)subscribe BY THE ACCOUNT OWNER must flip their linked, opted-OUT
 * customer profile back to marketing_opt_in=true (otherwise the consent gate's
 * profile short-circuit would leave them silently un-mailable). Consent-laundering
 * guard: an ANONYMOUS footer subscribe, or one made while signed in as ANOTHER
 * account, must NOT flip it (anyone can type a customer's email) — only the owner,
 * or staff holding newsletter:manage via the admin « Réabonner » (source "admin").
 * A newsletter-only address (no profile) and an already-opted-in profile are both
 * no-ops. A `source: "account"` event (sync-marketing-optin MIRRORING the profile
 * consent onto the newsletter row) never flips the profile back — even from the
 * owner — so the two syncs can't ping-pong. Self-cleaning (`__mailtest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/mailing-newsletter-sync.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { registerNewsletterToProfileSyncSubscriber } from "@/events/subscribers/sync-newsletter-to-profile";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";

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

type Row = Record<string, unknown>;
function rowsOf(res: unknown): Row[] {
  const r = res as { rows?: Row[] };
  return r.rows ?? (res as Row[]);
}

async function cleanup() {
  await db.execute(sql`delete from customer_user_links where user_id like '__mailtest%'`);
  await db.execute(sql`delete from customer_profiles where first_name = '__mailtest'`);
  // RBAC grants are soft text links (no FK) — delete before the users so a
  // hard-deleted test admin doesn't orphan a user_roles row.
  await db.execute(sql`delete from user_permissions where user_id like '__mailtest%'`);
  await db.execute(sql`delete from user_roles where user_id like '__mailtest%'`);
  await db.execute(sql`delete from users where id like '__mailtest%'`);
}

async function optInOf(pid: string): Promise<boolean | null> {
  const rows = rowsOf(
    await db.execute(sql`select marketing_opt_in from customer_profiles where id = ${pid}`),
  );
  return rows.length ? (rows[0].marketing_opt_in as boolean) : null;
}

// Access is role-only: an "admin" (newsletter:manage via the '*' wildcard) is
// seeded by granting the super_admin role.
async function mkUser(id: string, type: "customer" | "admin"): Promise<void> {
  await authService.insert({ id, email: `${id}@example.test`, name: id } as never);
  if (type === "admin") {
    const sa = await rbacService.findRoleByKey("super_admin");
    if (sa) await rbacService.assignRoleToUser(id, sa.id);
  }
}

async function mkCustomer(id: string, optIn: boolean): Promise<string> {
  await mkUser(id, "customer");
  const profile = await customerService.insertProfile({
    first_name: "__mailtest",
    last_name: "x",
    marketing_opt_in: optIn,
  } as never);
  await customerUserLink.create({ customer_profile_id: profile.id, user_id: id } as never);
  return profile.id;
}

/** Emit like the workflows do — `actorUserId` is the SIGNED-IN visitor/staff. */
async function emitSubscribe(email: string, actorUserId: string | null, source = "footer") {
  await bus.emit(
    "newsletter.subscribed",
    { email, source, reactivated: false },
    { actorIp: null, actorUserId },
  );
}

async function main() {
  await cleanup();
  registerNewsletterToProfileSyncSubscriber();

  const victimEmail = "__mailtest-ns-victim@example.test";
  const victimPid = await mkCustomer("__mailtest-ns-victim", false);
  await mkUser("__mailtest-ns-other", "customer");
  await mkUser("__mailtest-ns-staff", "admin"); // enum admin = '*' ⇒ newsletter:manage

  // 1) ANONYMOUS footer subscribe of an opted-OUT customer's email → NO flip
  //    (consent laundering: the public form proves nothing about the owner).
  await emitSubscribe(victimEmail, null);
  check("anonymous subscribe does NOT flip an opted-out profile", (await optInOf(victimPid)) === false);

  // 2) signed in as ANOTHER account → NO flip.
  await emitSubscribe(victimEmail, "__mailtest-ns-other");
  check("another account's subscribe does NOT flip it", (await optInOf(victimPid)) === false);

  // 3) a non-staff actor posting source "admin" → still NO flip (the source is
  //    attacker-controlled on the public form).
  await emitSubscribe(victimEmail, "__mailtest-ns-other", "admin");
  check("spoofed source=admin without newsletter:manage does NOT flip it", (await optInOf(victimPid)) === false);

  // 4) staff through the PUBLIC form (source footer) → NO flip: the override is
  //    only the explicit admin « Réabonner » action.
  await emitSubscribe(victimEmail, "__mailtest-ns-staff");
  check("staff actor via the public form does NOT flip it", (await optInOf(victimPid)) === false);

  // 5) admin « Réabonner » (newsletter:manage + source admin) → flips ON.
  await emitSubscribe(victimEmail, "__mailtest-ns-staff", "admin");
  check("admin « Réabonner » (newsletter:manage) flips it ON", (await optInOf(victimPid)) === true);

  // 6) the OWNER (signed in as the linked user) re-subscribes → profile flips ON.
  const outPid = await mkCustomer("__mailtest-ns-out", false);
  await emitSubscribe("__MAILTEST-NS-OUT@example.test", "__mailtest-ns-out"); // mixed-case → case-insensitive match
  check("owner's own subscribe flips the opted-out profile ON", (await optInOf(outPid)) === true);

  // 7) already opted-IN customer → no-op (stays ON, no throw).
  const inPid = await mkCustomer("__mailtest-ns-in", true);
  await emitSubscribe("__mailtest-ns-in@example.test", "__mailtest-ns-in");
  check("already-opted-in profile unchanged", (await optInOf(inPid)) === true);

  // 8) `source: "account"` is the profile→newsletter MIRROR — never looped back
  //    into the profile, even when the actor is the owner (a stale mirror must not
  //    re-opt-in a profile that was just opted out).
  const mirrorPid = await mkCustomer("__mailtest-ns-mirror", false);
  await emitSubscribe("__mailtest-ns-mirror@example.test", "__mailtest-ns-mirror", "account");
  check("source=account (mirror) from the owner does NOT flip the profile", (await optInOf(mirrorPid)) === false);

  // 9) newsletter-only address (no linked profile) → no throw.
  let threw = false;
  await emitSubscribe("__mailtest-ns-nobody@example.test", null).catch(() => {
    threw = true;
  });
  check("newsletter-only address → no throw", !threw);

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
