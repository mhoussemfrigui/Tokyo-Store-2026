import "server-only";

/**
 * Mailing — unsubscribe-workflow regression test. Verifies
 * `unsubscribeEmailFromMarketing` (the ONE sanctioned newsletter→profile reverse
 * writer): flips a linked profile's `marketing_opt_in=false`, unsubscribes the
 * newsletter row, emits `customer.profile_updated`, matches the address
 * case-INSENSITIVELY, and is idempotent. Also the admin « Désinscrire » path
 * (`unsubscribeSubscriberWorkflow`): withdraws consent on the newsletter row AND
 * the linked profile, names the staff actor on BOTH events, keeps the row (it is
 * the suppression record), is idempotent / validates its input, and reports a
 * swallowed write failure instead of a false success.
 * Self-cleaning (`__mailtest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/mailing-unsubscribe.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { unsubscribeEmailFromMarketing } from "@/workflows/customer/unsubscribe";
import { unsubscribeSubscriberWorkflow } from "@/workflows/newsletter/unsubscribe";
import { authService } from "@/modules/auth/service";
import { customerService } from "@/modules/customer/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { newsletterService } from "@/modules/newsletter/service";
import { bus } from "@/events/bus";

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
  await db.execute(sql`delete from newsletter_subscriptions where email like '__mailtest%'`);
  await db.execute(sql`delete from customer_user_links where user_id like '__mailtest%'`);
  await db.execute(sql`delete from customer_profiles where first_name = '__mailtest'`);
  await db.execute(sql`delete from users where id like '__mailtest%'`);
}

async function optInOf(pid: string): Promise<boolean | null> {
  const rows = rowsOf(
    await db.execute(sql`select marketing_opt_in from customer_profiles where id = ${pid}`),
  );
  return rows.length ? (rows[0].marketing_opt_in as boolean) : null;
}

async function main() {
  await cleanup();

  // A customer opted-in, with a linked user + an active newsletter row.
  await authService.insert({
    id: "__mailtest-uns",
    email: "__mailtest-uns@example.test",
    name: "__mailtest-uns",
    role: "customer",
  } as never);
  const profile = await customerService.insertProfile({
    first_name: "__mailtest",
    last_name: "x",
    marketing_opt_in: true,
  } as never);
  await customerUserLink.create({ customer_profile_id: profile.id, user_id: "__mailtest-uns" } as never);
  await newsletterService.insert({ email: "__mailtest-uns@example.test", source: "test" } as never);

  // Capture the parity event (the sync-marketing-optin subscriber is NOT loaded
  // in this standalone test, so we attach our own one-shot listener).
  let eventFired = false;
  bus.on("customer.profile_updated", (env) => {
    const p = env.payload as { customerProfileId?: string; changedFields?: string[] };
    if (p.customerProfileId === profile.id && (p.changedFields ?? []).includes("marketing_opt_in")) {
      eventFired = true;
    }
  });

  // Call with a DIFFERENT case to prove case-insensitive address matching.
  await unsubscribeEmailFromMarketing("__MAILTEST-UNS@EXAMPLE.TEST");

  check("profile marketing_opt_in flipped to false", (await optInOf(profile.id)) === false);
  const nl = await newsletterService.findByEmail("__mailtest-uns@example.test");
  check("newsletter row unsubscribed (is_active=false)", nl?.is_active === false);
  check("customer.profile_updated emitted with marketing_opt_in", eventFired);

  // Idempotent: a second call is a no-op and must not throw.
  await unsubscribeEmailFromMarketing("__mailtest-uns@example.test");
  check("second call idempotent (still opted-out)", (await optInOf(profile.id)) === false);

  // Unknown address: no row, no throw, no signal.
  let threw = false;
  await unsubscribeEmailFromMarketing("__mailtest-nobody@example.test").catch(() => {
    threw = true;
  });
  check("unknown address → no throw (anti-enumeration)", !threw);

  // ── Admin « Désinscrire » (unsubscribeSubscriberWorkflow) ──
  // A second opted-in customer with an active newsletter row.
  await authService.insert({
    id: "__mailtest-adm",
    email: "__mailtest-adm@example.test",
    name: "__mailtest-adm",
    role: "customer",
  } as never);
  const admProfile = await customerService.insertProfile({
    first_name: "__mailtest",
    last_name: "y",
    marketing_opt_in: true,
  } as never);
  await customerUserLink.create({ customer_profile_id: admProfile.id, user_id: "__mailtest-adm" } as never);
  const admRow = await newsletterService.insert({
    email: "__mailtest-adm@example.test",
    source: "footer",
  } as never);

  const ACTOR = "__mailtest-staff";
  let nlActor: string | null | undefined;
  let profileActor: string | null | undefined;
  bus.on("newsletter.unsubscribed", (env) => {
    if ((env.payload as { email?: string }).email === "__mailtest-adm@example.test") {
      nlActor = env.actorUserId;
    }
  });
  bus.on("customer.profile_updated", (env) => {
    const p = env.payload as { customerProfileId?: string };
    if (p.customerProfileId === admProfile.id) profileActor = env.actorUserId;
  });

  const r1 = await unsubscribeSubscriberWorkflow({ subscriberId: admRow.id }, { actorUserId: ACTOR });
  check("admin unsubscribe → ok (was active)", r1.ok && r1.data.alreadyInactive === false);
  const admNl = await newsletterService.findByEmail("__mailtest-adm@example.test");
  check("admin unsubscribe → row KEPT but inactive (suppression record)", admNl?.is_active === false);
  check("admin unsubscribe → unsubscribed_at stamped", admNl?.unsubscribed_at != null);
  check("admin unsubscribe → linked profile opted out", (await optInOf(admProfile.id)) === false);
  check("newsletter.unsubscribed names the staff actor", nlActor === ACTOR);
  check("customer.profile_updated names the staff actor", profileActor === ACTOR);

  const r2 = await unsubscribeSubscriberWorkflow({ subscriberId: admRow.id }, { actorUserId: ACTOR });
  check("admin unsubscribe again → ok, reported already inactive", r2.ok && r2.data.alreadyInactive === true);

  const rMissing = await unsubscribeSubscriberWorkflow(
    { subscriberId: "00000000-0000-7000-8000-000000000000" },
    { actorUserId: ACTOR },
  );
  check("unknown subscriber id → not_found", !rMissing.ok && rMissing.error === "not_found");
  const rBad = await unsubscribeSubscriberWorkflow({ subscriberId: "nope" }, { actorUserId: ACTOR });
  check("malformed id → validation", !rBad.ok && rBad.error === "validation");

  // A swallowed write failure in the best-effort delegate must NOT read as
  // success: the workflow re-reads the row and reports the failure.
  const failRow = await newsletterService.insert({
    email: "__mailtest-fail@example.test",
    source: "footer",
  } as never);
  const realUnsubscribe = newsletterService.unsubscribe;
  newsletterService.unsubscribe = async () => {
    throw new Error("simulated DB failure");
  };
  let rFail: Awaited<ReturnType<typeof unsubscribeSubscriberWorkflow>>;
  try {
    rFail = await unsubscribeSubscriberWorkflow({ subscriberId: failRow.id }, { actorUserId: ACTOR });
  } finally {
    newsletterService.unsubscribe = realUnsubscribe;
  }
  check("failed write → workflow fails (no false « désinscrite »)", !rFail.ok && rFail.error === "internal");
  check(
    "failed write → row still active (nothing claimed)",
    (await newsletterService.findByEmail("__mailtest-fail@example.test"))?.is_active === true,
  );

  // The recipient's own token opt-out stays actor-less (default opts).
  let selfActor: string | null | undefined = "unset";
  await newsletterService.insert({
    email: "__mailtest-self@example.test",
    source: "footer",
  } as never);
  bus.on("newsletter.unsubscribed", (env) => {
    if ((env.payload as { email?: string }).email === "__mailtest-self@example.test") {
      selfActor = env.actorUserId;
    }
  });
  await unsubscribeEmailFromMarketing("__mailtest-self@example.test");
  check("token opt-out (no opts) → no actor on the event", selfActor === null);
  check(
    "token opt-out → newsletter-only row unsubscribed",
    (await newsletterService.findByEmail("__mailtest-self@example.test"))?.is_active === false,
  );

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
