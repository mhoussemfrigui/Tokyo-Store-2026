import "server-only";

/**
 * Mailing — campaign enqueue + drain regression test. Drives the bulk path the
 * "Envoi" admin tab uses: `enqueueCampaign` renders the brand body ONCE and
 * bulk-inserts one queued row per recipient, each carrying ITS OWN unsubscribe
 * footer; the cron drain then sends them. Asserts: row count, campaign linkage,
 * marketing category, per-recipient footer splicing, and that a drain marks them
 * sent. FORCES the console provider (no real email). Self-cleaning (`__mailtest…`).
 * Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/mailing-campaign-send.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { enqueueCampaign, emailCampaignService } from "@/modules/mailing";
import { drainEmailQueue } from "@/lib/mailing/drain";
import { invalidateMailConfigCache } from "@/lib/email/config";

// A signing key MUST be present for the unsubscribe footer to render; set one for
// the duration of this test so the per-recipient splice is deterministic.
process.env.PAYMENT_ENCRYPTION_KEY = process.env.PAYMENT_ENCRYPTION_KEY || "__mailtest_signing_key_0123456789";

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
  await db.execute(
    sql`delete from email_campaigns where name = '__mailtest-campaign' or subject = '__mailtest Objet'`,
  );
}

async function rowFor(toEmail: string): Promise<Row | null> {
  const rows = rowsOf(
    await db.execute(
      sql`select id, status, category, campaign_id, body from email_logs
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

  const campaign = await emailCampaignService.create({
    name: "__mailtest-campaign",
    subject: "__mailtest Objet",
    body: "<p>Bonjour</p>",
    audienceKind: "addresses",
    audienceAddresses: "__mailtest-c1@example.test, __mailtest-c2@example.test",
    totalRecipients: 2,
  });

  const enqueued = await enqueueCampaign({
    subject: "__mailtest Objet",
    html: "<p>Bonjour</p>",
    recipients: [{ email: "__mailtest-c1@example.test" }, { email: "__mailtest-c2@example.test" }],
    campaignId: campaign.id,
  });
  check("enqueueCampaign enqueued 2 rows", enqueued === 2);

  const r1 = await rowFor("__mailtest-c1@example.test");
  const r2 = await rowFor("__mailtest-c2@example.test");
  check("row 1 linked to campaign", r1?.campaign_id === campaign.id);
  check("row 2 linked to campaign", r2?.campaign_id === campaign.id);
  check("rows are category=marketing", r1?.category === "marketing" && r2?.category === "marketing");
  check("each body carries the unsubscribe link", String(r1?.body).includes("/se-desabonner"));
  check(
    "per-recipient footer splice → distinct bodies (distinct signed tokens)",
    String(r1?.body) !== String(r2?.body),
  );

  // The cron drain sends both queued rows (transactional path bypasses the
  // consent gate? No — these are marketing; with no opt-out row the gate passes).
  const drained = await drainEmailQueue();
  check("drain sent the 2 campaign rows", drained.sent >= 2);
  check("row 1 → sent", (await rowFor("__mailtest-c1@example.test"))?.status === "sent");
  check("row 2 → sent", (await rowFor("__mailtest-c2@example.test"))?.status === "sent");

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
