import "server-only";

/**
 * Phase 1 — dispatch-logging regression test. FORCES the console provider (the
 * DB `mail.provider` setting wins over env) so NO real email is ever sent, then
 * dispatches through the single chokepoint and asserts a send-log row is recorded
 * — including body+variable REDACTION for sensitive templates. Also: a stored
 * is_enabled=false override can NOT block an account-security (`critical`)
 * template (defence in depth behind the toggle guard), while it still skips a
 * normal one. Self-cleaning (rows tagged `__mailtest…`; overrides restored). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/mailing-dispatch-logging.test.ts
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { dispatchEmail } from "@/modules/mailing";
import { invalidateMailConfigCache } from "@/lib/email/config";

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
}

/** Snapshot + force an `is_enabled=false` override row; returns a restore fn. */
async function disableTemplate(key: string): Promise<() => Promise<void>> {
  const prior = rowsOf(
    await db.execute(sql`select is_enabled from email_template_overrides where template_key = ${key}`),
  )[0];
  await db.execute(
    sql`insert into email_template_overrides (template_key, is_enabled) values (${key}, false)
        on conflict (template_key) do update set is_enabled = false`,
  );
  return async () => {
    if (!prior) await db.execute(sql`delete from email_template_overrides where template_key = ${key}`);
    else
      await db.execute(
        sql`update email_template_overrides set is_enabled = ${prior.is_enabled as boolean} where template_key = ${key}`,
      );
  };
}

async function readSetting(key: string): Promise<string | null | undefined> {
  const rows = rowsOf(await db.execute(sql`select value from site_settings where key = ${key}`));
  return rows.length ? (rows[0].value as string | null) : undefined;
}

/** Poll for the async, best-effort log write the chokepoint fires (not awaited). */
async function waitForLog(toEmail: string): Promise<Row | null> {
  for (let i = 0; i < 60; i++) {
    const rows = rowsOf(
      await db.execute(sql`select * from email_logs where to_email = ${toEmail} limit 1`),
    );
    if (rows.length) return rows[0];
    await new Promise((res) => setTimeout(res, 50));
  }
  return null;
}

async function main() {
  await cleanup();
  const prior = await readSetting("mail.provider");
  // Force the console provider so the test never dispatches a real email.
  await db.execute(
    sql`insert into site_settings (key, value, type, label) values ('mail.provider','console','text','test')
        on conflict (key) do update set value = 'console'`,
  );
  process.env.EMAIL_PROVIDER = "console";
  invalidateMailConfigCache();

  // 1) non-sensitive template → logged, sent, NOT redacted.
  const r1 = await dispatchEmail({
    key: "welcome",
    to: "__mailtest-welcome@example.test",
    variables: { first_name: "Test", shop_url: "https://example.test" },
  });
  check("welcome dispatched (sent)", r1.sent === true);
  const log1 = await waitForLog("__mailtest-welcome@example.test");
  check("welcome logged a row", !!log1);
  check("welcome status = sent", log1?.status === "sent");
  check("welcome category = account", log1?.category === "account");
  check("welcome provider = console", log1?.provider === "console");
  check("welcome template_key recorded", log1?.template_key === "welcome");
  check(
    "welcome body NOT redacted",
    typeof log1?.body === "string" && log1.body !== "[redacted]" && (log1.body as string).length > 0,
  );

  // 2) sensitive template (password_reset) → body + variables REDACTED.
  const r2 = await dispatchEmail({
    key: "password_reset",
    to: "__mailtest-reset@example.test",
    variables: { first_name: "Test", reset_url: "https://example.test/reset", expires_minutes: 60 },
  });
  check("password_reset dispatched (sent)", r2.sent === true);
  const log2 = await waitForLog("__mailtest-reset@example.test");
  check("password_reset logged a row", !!log2);
  check("password_reset body = [redacted]", log2?.body === "[redacted]");
  check("password_reset variables = null (redacted)", log2?.variables === null);

  // 3) a stored is_enabled=false override on a CRITICAL template is ignored —
  //    password recovery / verification can never be silently switched off.
  const restoreReset = await disableTemplate("password_reset");
  try {
    const r3 = await dispatchEmail({
      key: "password_reset",
      to: "__mailtest-reset-disabled@example.test",
      variables: { first_name: "Test", reset_url: "https://example.test/reset", expires_minutes: 60 },
    });
    check("critical template with a disabled override STILL sends", r3.sent === true && !r3.skipped);
  } finally {
    await restoreReset();
  }

  // 4) …while a NON-critical template's disabled override is still honoured.
  const restoreWelcome = await disableTemplate("welcome");
  try {
    const r4 = await dispatchEmail({
      key: "welcome",
      to: "__mailtest-welcome-disabled@example.test",
      variables: { first_name: "Test", shop_url: "https://example.test" },
    });
    check("non-critical template with a disabled override is skipped", r4.skipped === true && r4.reason === "disabled");
  } finally {
    await restoreWelcome();
  }

  // Restore the provider setting + clean up.
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
