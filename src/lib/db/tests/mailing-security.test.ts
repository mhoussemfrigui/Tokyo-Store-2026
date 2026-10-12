import "server-only";

/**
 * Mailing security + integrity regression test.
 *
 *   1. Critical templates (`critical`: password_reset, email_verification,
 *      email_change, user_invitation, purge_confirmation — the account-security
 *      set) — exactly the set dispatch redacts from the send log (parsed from
 *      dispatch.ts so the two can't drift). They can't be disabled, and only a
 *      super-admin may override them (a delegated operator could otherwise
 *      exfiltrate a reset token).
 *   2. The « Fournisseur d'envoi » save plan (lib/email/mail-settings):
 *      - a non-super-admin form carrying ANY transport field is refused;
 *      - provider/from/reply-to equal to the env/default fallback persist NULL
 *        (an unchanged save never pins "console" over EMAIL_PROVIDER=resend);
 *      - SMTP keys only for provider=smtp, sendmail path only for internal, and
 *        absent fields are never written (switching provider keeps the config).
 *   3. DB round-trip: with EMAIL_PROVIDER=resend and no DB row, the resolver says
 *      "resend", an unchanged save keeps it "resend", an explicit pick still
 *      overrides, and picking the env value again reverts to env.
 *
 * Self-restoring (the touched `mail.*` rows are put back). Run:
 *   pnpm exec tsx --conditions=react-server --env-file-if-exists=.env.local \
 *     src/lib/db/tests/mailing-security.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EMAIL_TEMPLATES, isCriticalTemplate } from "@/modules/mailing/templates";
import {
  mailSettingToPersist,
  parseMailProviderName,
  planMailSettingsWrites,
  type MailSettingsPlan,
} from "@/lib/email/mail-settings";
import {
  invalidateMailConfigCache,
  mailEnvDefaults,
  resolveMailProviderConfig,
} from "@/lib/email/config";
import { settingService } from "@/modules/cms/setting/service";
import { upsertSettingWorkflow } from "@/workflows/cms/setting";

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

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const DEFAULTS = {
  providerName: "resend",
  from: "Tokyo Store <noreply@tokyostore.tn>",
  replyTo: undefined,
};
const noEnvLock = () => false;

function writesOf(plan: MailSettingsPlan): Map<string, string | null> {
  return new Map(plan.ok ? plan.writes.map((w) => [w.key, w.value]) : []);
}

function pureChecks() {
  // ── 1. critical templates ───────────────────────────────────────────────
  const critical = EMAIL_TEMPLATES.filter((t) => t.critical).map((t) => t.key).sort();
  check(
    "critical templates = the 5 account-security keys",
    JSON.stringify(critical) ===
      JSON.stringify(
        [
          "email_change",
          "email_verification",
          "password_reset",
          "purge_confirmation",
          "user_invitation",
        ],
      ),
  );
  const dispatchSrc = readFileSync(
    join(process.cwd(), "src", "modules", "mailing", "dispatch.ts"),
    "utf8",
  );
  const redactedBlock =
    /const REDACTED_KEYS = new Set<EmailTemplateKey>\(\[([\s\S]*?)\]\);/.exec(dispatchSrc)?.[1] ?? "";
  const redacted = [...redactedBlock.replace(/\/\/.*$/gm, "").matchAll(/"([a-z_]+)"/g)]
    .map((m) => m[1])
    .sort();
  check(
    "critical set === dispatch REDACTED_KEYS (no drift)",
    redacted.length > 0 && JSON.stringify(redacted) === JSON.stringify(critical),
  );
  check("isCriticalTemplate(password_reset) = true", isCriticalTemplate("password_reset"));
  check("isCriticalTemplate(welcome) = false", !isCriticalTemplate("welcome"));
  check("isCriticalTemplate(unknown) = false", !isCriticalTemplate("nope"));

  // ── 2. pure helpers ─────────────────────────────────────────────────────
  check("parseMailProviderName normalises case", parseMailProviderName(" Resend ") === "resend");
  check("parseMailProviderName rejects unknown", parseMailProviderName("mailgun") === undefined);
  check("persist: equal to env → NULL", mailSettingToPersist("resend", "resend") === null);
  check(
    "persist: equal to env (case-insensitive) → NULL",
    mailSettingToPersist("RESEND", "resend", { caseInsensitive: true }) === null,
  );
  check("persist: different from env → pinned", mailSettingToPersist("console", "resend") === "console");
  check("persist: blank → NULL", mailSettingToPersist("  ", "resend") === null);
  check("persist: no env default → pinned", mailSettingToPersist("a@b.tn", undefined) === "a@b.tn");

  // ── 2b. save plan: owner gate (admin-authz-02) ──────────────────────────
  const delegate = { canEditTransport: false, defaults: DEFAULTS, envLocked: noEnvLock };
  const owner = { canEditTransport: true, defaults: DEFAULTS, envLocked: noEnvLock };

  const p1 = planMailSettingsWrites(form({ "mail.provider": "smtp", "mail.smtp_host": "evil.example" }), delegate);
  check("delegate: provider + SMTP host → forbidden", !p1.ok && p1.error === "forbidden");
  const p2 = planMailSettingsWrites(form({ "mail.smtp_host": "evil.example" }), delegate);
  check("delegate: SMTP host alone → forbidden", !p2.ok && p2.error === "forbidden");
  const p3 = planMailSettingsWrites(form({ "mail.resend_api_key": "re_x" }), delegate);
  check("delegate: Resend key → forbidden", !p3.ok && p3.error === "forbidden");
  const p4 = planMailSettingsWrites(form({ "mail.sendmail_path": "/bin/sh" }), delegate);
  check("delegate: sendmail path → forbidden", !p4.ok && p4.error === "forbidden");
  const p5 = planMailSettingsWrites(
    form({ "mail.from": "Boutique <shop@example.tn>", "mail.reply_to": "sav@example.tn" }),
    delegate,
  );
  const w5 = writesOf(p5);
  check(
    "delegate: from/reply-to only → allowed, writes exactly those two",
    p5.ok && w5.size === 2 && w5.get("mail.from") === "Boutique <shop@example.tn>" &&
      w5.get("mail.reply_to") === "sav@example.tn",
  );

  // ── 2c. save plan: env-provider pin (content-mail-01) ───────────────────
  const unchanged = planMailSettingsWrites(
    form({ "mail.provider": "resend", "mail.from": DEFAULTS.from, "mail.reply_to": "" }),
    owner,
  );
  const wu = writesOf(unchanged);
  check("unchanged save: provider == env → NULL (not pinned)", unchanged.ok && wu.get("mail.provider") === null);
  check("unchanged save: from == env default → NULL", wu.get("mail.from") === null);
  check("unchanged save: blank reply-to → NULL", wu.get("mail.reply_to") === null);
  const pick = writesOf(planMailSettingsWrites(form({ "mail.provider": "console" }), owner));
  check("explicit pick different from env → pinned", pick.get("mail.provider") === "console");
  const bad = planMailSettingsWrites(form({ "mail.provider": "mailgun" }), owner);
  check("unknown provider → validation", !bad.ok && bad.error === "validation");

  // ── 2d. save plan: other providers' config untouched (content-mail-10) ──
  const toResend = writesOf(planMailSettingsWrites(form({ "mail.provider": "resend" }), owner));
  check(
    "provider=resend: no SMTP / sendmail key written",
    ![...toResend.keys()].some((k) => k.startsWith("mail.smtp_") || k === "mail.sendmail_path"),
  );
  const smtp = writesOf(
    planMailSettingsWrites(
      form({
        "mail.provider": "smtp",
        "mail.smtp_host": "smtp.example.tn",
        "mail.smtp_port": "587",
        "mail.smtp_user": "u",
      }),
      owner,
    ),
  );
  check(
    "provider=smtp: host/port/user written, TLS off when unchecked",
    smtp.get("mail.smtp_host") === "smtp.example.tn" && smtp.get("mail.smtp_port") === "587" &&
      smtp.get("mail.smtp_user") === "u" && smtp.get("mail.smtp_secure") === "false",
  );
  check("provider=smtp: sendmail path untouched", !smtp.has("mail.sendmail_path"));
  const smtpNoHost = writesOf(
    planMailSettingsWrites(form({ "mail.provider": "smtp", "mail.smtp_secure": "on" }), owner),
  );
  check(
    "provider=smtp: an ABSENT field is never nulled",
    !smtpNoHost.has("mail.smtp_host") && smtpNoHost.get("mail.smtp_secure") === "true",
  );
  const locked = writesOf(
    planMailSettingsWrites(form({ "mail.provider": "smtp", "mail.smtp_host": "x" }), {
      ...owner,
      envLocked: (v) => v === "SMTP_HOST",
    }),
  );
  check("env-locked SMTP_HOST → host not written", !locked.has("mail.smtp_host"));
  const internal = writesOf(
    planMailSettingsWrites(form({ "mail.provider": "internal", "mail.sendmail_path": "/usr/sbin/sendmail" }), owner),
  );
  check(
    "provider=internal: sendmail written, SMTP untouched",
    internal.get("mail.sendmail_path") === "/usr/sbin/sendmail" &&
      ![...internal.keys()].some((k) => k.startsWith("mail.smtp_")),
  );
}

const TOUCHED = ["mail.provider", "mail.from", "mail.reply_to"];

async function dbChecks() {
  // Snapshot the rows we touch so the run leaves the DB exactly as found.
  const snapshot = new Map<string, Awaited<ReturnType<typeof settingService.findByKey>>>();
  for (const k of TOUCHED) snapshot.set(k, await settingService.findByKey(k));
  const prevEnv = process.env.EMAIL_PROVIDER;

  try {
    process.env.EMAIL_PROVIDER = "resend";
    await settingService.deleteByKeys(TOUCHED);
    invalidateMailConfigCache();

    const defaults = mailEnvDefaults();
    check("env defaults: EMAIL_PROVIDER=resend is detected", defaults.providerName === "resend" && defaults.providerFromEnv);
    check("resolver with no DB row → resend", (await resolveMailProviderConfig()).providerName === "resend");

    const save = async (entries: Record<string, string>) => {
      const plan = planMailSettingsWrites(form(entries), {
        canEditTransport: true,
        defaults: mailEnvDefaults(),
        envLocked: (v) => Boolean(process.env[v]?.trim()),
      });
      if (!plan.ok) throw new Error(`plan refused: ${plan.error}`);
      for (const w of plan.writes) {
        const res = await upsertSettingWorkflow({
          key: w.key,
          value: w.value,
          type: "text",
          groupKey: "mail",
          label: w.label,
        });
        if (!res.ok) throw new Error(res.message);
      }
      invalidateMailConfigCache();
      return resolveMailProviderConfig();
    };

    // The hub now seeds the form from the resolver ("resend"), so an unchanged
    // save posts "resend" + the effective From — it must NOT switch to console.
    const r1 = await save({ "mail.provider": "resend", "mail.from": defaults.from, "mail.reply_to": "" });
    check("unchanged save keeps the env provider (resend)", r1.providerName === "resend");
    check("unchanged save keeps the env From", r1.from === defaults.from);

    const r2 = await save({ "mail.provider": "console", "mail.from": defaults.from, "mail.reply_to": "" });
    check("explicit pick (console) still overrides env", r2.providerName === "console");

    const r3 = await save({ "mail.provider": "resend", "mail.from": defaults.from, "mail.reply_to": "" });
    check("re-picking the env value reverts to env (resend)", r3.providerName === "resend");
    const row = await settingService.findByKey("mail.provider");
    check("…and the DB pin is cleared (NULL)", !row || row.value === null);
  } finally {
    if (prevEnv === undefined) delete process.env.EMAIL_PROVIDER;
    else process.env.EMAIL_PROVIDER = prevEnv;
    await settingService.deleteByKeys(TOUCHED);
    for (const [, r] of snapshot) {
      if (r) {
        await settingService.upsert({
          key: r.key,
          value: r.value,
          type: r.type,
          group_key: r.group_key,
          label: r.label,
          description: r.description,
        });
      }
    }
    invalidateMailConfigCache();
  }
}

async function main() {
  pureChecks();
  await dbChecks();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
