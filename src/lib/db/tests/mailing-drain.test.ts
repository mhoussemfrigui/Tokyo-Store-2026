import "server-only";

/**
 * Phase 3 — email-queue drain regression test. FORCES the console provider (no
 * real email) and exercises: claim+send, marketing consent re-check at send time,
 * no double-send on a second drain, and backoff (a re-queued row with a future
 * next_attempt_at is NOT claimed). Also the single-flight guarantees: the batch
 * is sized from the throttle so it ends before the next cron tick
 * (drainBatchSize) and two CONCURRENT drains never
 * both run — one is skipped by the advisory lock, so nothing is sent twice and
 * the throttle isn't multiplied. Self-cleaning (`__mailtest…`). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/mailing-drain.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { emailLogService } from "@/modules/mailing";
import { drainBatchSize, drainEmailQueue } from "@/lib/mailing/drain";
import { dailyMarketingWindow } from "@/lib/mailing/daily-limit";
import { invalidateMailConfigCache } from "@/lib/email/config";
import { authService } from "@/modules/auth/service";
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
  await db.execute(sql`delete from email_logs where to_email like '__mailtest%'`);
  await db.execute(sql`delete from customer_user_links where user_id like '__mailtest%'`);
  await db.execute(sql`delete from customer_profiles where first_name = '__mailtest'`);
  await db.execute(sql`delete from users where id like '__mailtest%'`);
}

async function rowFor(toEmail: string): Promise<Row | null> {
  const rows = rowsOf(
    await db.execute(
      sql`select id, status, error_message, attempts, next_attempt_at from email_logs
          where to_email = ${toEmail} order by created_at desc limit 1`,
    ),
  );
  return rows[0] ?? null;
}

async function readSetting(key: string): Promise<string | null | undefined> {
  const rows = rowsOf(await db.execute(sql`select value from site_settings where key = ${key}`));
  return rows.length ? (rows[0].value as string | null) : undefined;
}

async function main() {
  await cleanup();
  const prior = await readSetting("mail.provider");
  await db.execute(
    sql`insert into site_settings (key, value, type, label) values ('mail.provider','console','text','test')
        on conflict (key) do update set value = 'console'`,
  );
  process.env.EMAIL_PROVIDER = "console";
  invalidateMailConfigCache();

  // Enqueue 2 transactional (no consent gate) rows.
  await emailLogService.enqueue([
    { toEmail: "__mailtest-q1@example.test", subject: "S", body: "<p>x</p>", category: "commerce" },
    { toEmail: "__mailtest-q2@example.test", subject: "S", body: "<p>x</p>", category: "commerce" },
  ]);
  // An opted-out customer + a queued MARKETING row to them (drain must skip it).
  await authService.insert({
    id: "__mailtest-opt",
    email: "__mailtest-opt@example.test",
    name: "__mailtest-opt",
    role: "customer",
  } as never);
  const prof = await customerService.insertProfile({
    first_name: "__mailtest",
    last_name: "x",
    marketing_opt_in: false,
  } as never);
  await customerUserLink.create({ customer_profile_id: prof.id, user_id: "__mailtest-opt" } as never);
  await emailLogService.enqueue([
    { toEmail: "__mailtest-opt@example.test", subject: "S", body: "<p>x</p>", category: "marketing" },
  ]);

  const r1 = await drainEmailQueue();
  check("drain sent 2 transactional", r1.sent === 2);
  check("drain skipped 1 (opted-out marketing)", r1.skipped === 1);
  check("q1 row → sent", (await rowFor("__mailtest-q1@example.test"))?.status === "sent");
  check(
    "opted-out marketing row → failed terminal",
    (await rowFor("__mailtest-opt@example.test"))?.status === "failed",
  );

  // Second drain finds nothing — no double-send.
  const r2 = await drainEmailQueue();
  check("second drain empty (no double-send)", r2.sent === 0 && r2.status === "skipped");

  // Backoff: a row re-queued with a FUTURE next_attempt_at is not claimed.
  await emailLogService.enqueue([
    { toEmail: "__mailtest-bk@example.test", subject: "S", body: "<p>x</p>", category: "commerce" },
  ]);
  const bk = await rowFor("__mailtest-bk@example.test");
  // markRetry is a drain FINALIZER — in production it only runs on a CLAIMED
  // (status='pending') row, and the finalizers now guard on that (so a late
  // finalize can't clobber a re-claimed send). Put the row in the claimed state
  // first, matching the real lifecycle.
  await db.execute(sql`update email_logs set status = 'pending' where id = ${String(bk?.id)}`);
  await emailLogService.markRetry(String(bk?.id), "transient", 3600);
  const after = await rowFor("__mailtest-bk@example.test");
  check(
    "retry → re-queued with future next_attempt_at",
    after?.status === "queued" && after?.next_attempt_at != null,
  );
  const r3 = await drainEmailQueue();
  check("not-due (backoff) row not claimed", r3.sent === 0);

  // Finalizer ownership guard: a late markSent on a row NOT in the claimed
  // (pending) state must NO-OP — so a drain whose batch was recovered + re-claimed
  // can't clobber the new send's result. The row here is 'queued' (never claimed).
  await emailLogService.enqueue([
    { toEmail: "__mailtest-guard@example.test", subject: "S", body: "<p>x</p>", category: "commerce" },
  ]);
  const g = await rowFor("__mailtest-guard@example.test");
  await emailLogService.markSent(String(g?.id), "prov-msg", "console", "from@x.test");
  const gAfter = await rowFor("__mailtest-guard@example.test");
  check("markSent on a non-pending (queued) row no-ops (pending-guard)", gAfter?.status === "queued");
  // Remove it so its leftover 'queued' state doesn't get claimed by a later drain.
  await db.execute(sql`delete from email_logs where to_email = '__mailtest-guard@example.test'`);

  // Opt-out RACE: a marketing row enqueued while the customer was opted-IN must
  // still be skipped if they opt OUT before the drain (consent is re-checked at
  // send time, not enqueue time).
  await authService.insert({
    id: "__mailtest-race",
    email: "__mailtest-race@example.test",
    name: "__mailtest-race",
    role: "customer",
  } as never);
  const raceProf = await customerService.insertProfile({
    first_name: "__mailtest",
    last_name: "x",
    marketing_opt_in: true, // opted-IN at enqueue
  } as never);
  await customerUserLink.create({ customer_profile_id: raceProf.id, user_id: "__mailtest-race" } as never);
  await emailLogService.enqueue([
    { toEmail: "__mailtest-race@example.test", subject: "S", body: "<p>x</p>", category: "marketing" },
  ]);
  // ...then opts OUT before the drain runs.
  await db.execute(
    sql`update customer_profiles set marketing_opt_in = false where id = ${raceProf.id}`,
  );
  const rRace = await drainEmailQueue();
  check("opt-out race → row skipped (re-check at send)", rRace.skipped >= 1 && rRace.sent === 0);
  check(
    "opt-out race → row marked failed terminal",
    (await rowFor("__mailtest-race@example.test"))?.status === "failed",
  );

  // Crash recovery: a row stranded in 'pending' (claimed, then the worker died)
  // older than the stale window is re-queued and sent on the next drain.
  await emailLogService.enqueue([
    { toEmail: "__mailtest-stale@example.test", subject: "S", body: "<p>x</p>", category: "commerce" },
  ]);
  const stale = await rowFor("__mailtest-stale@example.test");
  await db.execute(
    sql`update email_logs set status = 'pending', updated_at = now() - interval '60 minutes' where id = ${String(stale?.id)}`,
  );
  const rStale = await drainEmailQueue();
  check("stale-pending recovered + sent", rStale.sent >= 1);
  check(
    "stale-pending row → sent (no longer stranded)",
    (await rowFor("__mailtest-stale@example.test"))?.status === "sent",
  );

  // Master kill-switch: with mail.marketing_enabled=false, a queued MARKETING row
  // is cut by the drain (transactional rows still send).
  const priorMkt = await readSetting("mail.marketing_enabled");
  await db.execute(
    sql`insert into site_settings (key, value, type, label) values ('mail.marketing_enabled','false','boolean','test')
        on conflict (key) do update set value = 'false'`,
  );
  await emailLogService.enqueue([
    { toEmail: "__mailtest-ks-mkt@example.test", subject: "S", body: "<p>x</p>", category: "marketing" },
    { toEmail: "__mailtest-ks-txn@example.test", subject: "S", body: "<p>x</p>", category: "commerce" },
  ]);
  const rKs = await drainEmailQueue();
  check("kill-switch → marketing row cut (skipped)", rKs.skipped >= 1);
  check(
    "kill-switch → marketing row failed terminal",
    (await rowFor("__mailtest-ks-mkt@example.test"))?.status === "failed",
  );
  check(
    "kill-switch → transactional row still sent",
    (await rowFor("__mailtest-ks-txn@example.test"))?.status === "sent",
  );
  if (priorMkt === undefined) {
    await db.execute(sql`delete from site_settings where key = 'mail.marketing_enabled'`);
  } else {
    await db.execute(sql`update site_settings set value = ${priorMkt} where key = 'mail.marketing_enabled'`);
  }

  // Batch sized from the throttle: one batch fits one 2-min cron interval minus
  // ~10 s of headroom, capped at 50 — a throttle of 1/min no longer claims 50 rows
  // it needs ~50 min to send (which let the 30-min stale recovery re-queue +
  // double-send the tail), and a mid-range throttle no longer spills past the
  // next tick (which the lock would skip, halving the real throughput).
  check("batch size: 1/min → 2", drainBatchSize(1) === 2);
  check("batch size: 10/min → 19", drainBatchSize(10) === 19);
  check("batch size: 25/min → 46", drainBatchSize(25) === 46);
  check("batch size: 27/min → 50 (cap)", drainBatchSize(27) === 50);
  check("batch size: 300/min → 50 (cap)", drainBatchSize(300) === 50);
  check("batch size: invalid throttle → still ≥ 1", drainBatchSize(0) >= 1 && drainBatchSize(NaN) >= 1);
  // Invariant for every throttle: the LAST paced send of a batch starts at
  // (n − 1) × delay (the drain's delayMs formula) — ≥ 10 s before the next tick.
  let latestStartMs = 0;
  for (let perMin = 1; perMin <= 600; perMin++) {
    const delayMs = Math.floor(60_000 / perMin);
    latestStartMs = Math.max(latestStartMs, (drainBatchSize(perMin) - 1) * delayMs);
  }
  check("batch size: last paced send starts ≤ 110 s into a 120 s interval", latestStartMs <= 110_000);

  // Single-flight: two drains fired together → exactly one runs (the other is
  // skipped by the advisory lock), every row is sent exactly once.
  await emailLogService.enqueue([
    { toEmail: "__mailtest-lock1@example.test", subject: "S", body: "<p>x</p>", category: "commerce" },
    { toEmail: "__mailtest-lock2@example.test", subject: "S", body: "<p>x</p>", category: "commerce" },
    { toEmail: "__mailtest-lock3@example.test", subject: "S", body: "<p>x</p>", category: "commerce" },
  ]);
  const [dA, dB] = await Promise.all([drainEmailQueue(), drainEmailQueue()]);
  const lockSkipped = [dA, dB].filter((r) => r.status === "skipped" && r.summary.includes("déjà en cours"));
  check("concurrent drains → exactly one skipped by the lock", lockSkipped.length === 1);
  check("concurrent drains → the other sent all 3", dA.sent + dB.sent === 3);
  const lockRows = rowsOf(
    await db.execute(
      sql`select status, attempts from email_logs where to_email like '__mailtest-lock%' order by to_email`,
    ),
  );
  check(
    "concurrent drains → each row sent once (attempts = 1)",
    lockRows.length === 3 && lockRows.every((r) => r.status === "sent" && Number(r.attempts) === 1),
  );
  // The lock is released with the run: the next drain proceeds normally.
  const dAfter = await drainEmailQueue();
  check("lock released after the run (next drain not lock-skipped)", !dAfter.summary.includes("déjà en cours"));

  // ── Daily marketing cap: once today's marketing-sent count hits mail.daily_limit,
  //    further MARKETING rows are DEFERRED to the next reset (campaign pauses);
  //    transactional rows still send. Baseline-relative (limit = already-sent + 1)
  //    so it's deterministic in a shared dev DB that may already hold sent rows. ──
  const priorLimit = await readSetting("mail.daily_limit");
  const priorReset = await readSetting("mail.daily_reset_time");
  await db.execute(
    sql`insert into site_settings (key, value, type, label) values ('mail.daily_reset_time','00:00','text','test')
        on conflict (key) do update set value = '00:00'`,
  );
  const win = dailyMarketingWindow(Date.now(), "00:00");
  const baseline = await emailLogService.countMarketingSentSince(new Date(win.boundaryMs));
  const cap = baseline + 1;
  await db.execute(
    sql`insert into site_settings (key, value, type, label) values ('mail.daily_limit', ${String(cap)}, 'number','test')
        on conflict (key) do update set value = ${String(cap)}`,
  );
  await emailLogService.enqueue([
    { toEmail: "__mailtest-cap1@example.test", subject: "S", body: "<p>x</p>", category: "marketing" },
    { toEmail: "__mailtest-cap2@example.test", subject: "S", body: "<p>x</p>", category: "marketing" },
    { toEmail: "__mailtest-captxn@example.test", subject: "S", body: "<p>x</p>", category: "commerce" },
  ]);
  const rCap = await drainEmailQueue();
  check("daily cap → at least one marketing row paused (deferred)", rCap.paused >= 1);
  const cap1 = await rowFor("__mailtest-cap1@example.test");
  const cap2 = await rowFor("__mailtest-cap2@example.test");
  const capSent = [cap1, cap2].filter((r) => r?.status === "sent").length;
  const capDeferred = [cap1, cap2].filter((r) => r?.status === "queued" && r?.next_attempt_at != null).length;
  check("daily cap → exactly one of the two marketing rows sent", capSent === 1);
  check("daily cap → the other marketing row deferred (queued + future next_attempt_at)", capDeferred === 1);
  check(
    "daily cap → transactional row still sent (never capped)",
    (await rowFor("__mailtest-captxn@example.test"))?.status === "sent",
  );
  // The deferred row's next_attempt_at is the next reset → not re-claimed today.
  await drainEmailQueue();
  const cap1b = await rowFor("__mailtest-cap1@example.test");
  const cap2b = await rowFor("__mailtest-cap2@example.test");
  check(
    "daily cap → second drain re-sends no capped marketing (still paused)",
    [cap1b, cap2b].filter((r) => r?.status === "sent").length === 1,
  );
  // Restore the daily-cap settings.
  for (const [key, val] of [["mail.daily_limit", priorLimit], ["mail.daily_reset_time", priorReset]] as const) {
    if (val === undefined) await db.execute(sql`delete from site_settings where key = ${key}`);
    else await db.execute(sql`update site_settings set value = ${val} where key = ${key}`);
  }

  if (prior === undefined) {
    await db.execute(sql`delete from site_settings where key = 'mail.provider'`);
  } else {
    await db.execute(sql`update site_settings set value = ${prior} where key = 'mail.provider'`);
  }
  invalidateMailConfigCache();
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
