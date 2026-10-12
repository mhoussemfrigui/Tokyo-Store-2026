/**
 * Pure rules behind the admin « Fournisseur d'envoi » save
 * (`saveMailSettingsAction`) — which `mail.*` settings rows get written for a
 * submitted form. Kept free of DB/session access so the security + integrity
 * invariants are unit-testable:
 *
 *   - The TRANSPORT (provider, SMTP relay, sendmail binary, provider secrets)
 *     receives every email — password-reset / invitation links included — so a
 *     form carrying any transport field is refused unless the actor may edit it
 *     (super-admin `*`); otherwise a delegated operator could point the relay at
 *     themselves and harvest a super-admin's reset link.
 *   - Provider / from / reply-to are DB-first in the resolver, so a value equal
 *     to the env/default fallback is stored as NULL: saving the form unchanged
 *     never pins a value that would shadow EMAIL_PROVIDER (e.g. "console" over
 *     "resend" in production) or a later env change.
 *   - SMTP host/port/user/TLS are written only when SMTP is the submitted
 *     provider, the sendmail path only for the internal mailer, and a field
 *     ABSENT from the form is never written — switching provider can't wipe the
 *     other provider's stored config.
 *   - Env-locked fields (SMTP_HOST, …) are skipped: the env value already wins.
 */

export type MailProviderName = "resend" | "smtp" | "console" | "internal";

/** A supported provider name (case-insensitive), or undefined when blank/unknown. */
export function parseMailProviderName(raw: string | null | undefined): MailProviderName | undefined {
  const name = (raw ?? "").trim().toLowerCase();
  return name === "resend" || name === "smtp" || name === "internal" || name === "console"
    ? name
    : undefined;
}

/**
 * The value to PERSIST for a DB-first mail field (provider / from / reply-to):
 * blank, or equal to the env/default fallback, stores NULL so the environment
 * stays authoritative; anything else is an explicit admin pin.
 */
export function mailSettingToPersist(
  submitted: string | null | undefined,
  envDefault: string | null | undefined,
  opts: { caseInsensitive?: boolean } = {},
): string | null {
  const v = (submitted ?? "").trim();
  if (!v) return null;
  const d = (envDefault ?? "").trim();
  if (!d) return v;
  const same = opts.caseInsensitive ? v.toLowerCase() === d.toLowerCase() : v === d;
  return same ? null : v;
}

/** Form fields that configure the mail TRANSPORT (super-admin only). */
export const MAIL_TRANSPORT_FIELDS = [
  "mail.provider",
  "mail.resend_api_key",
  "mail.smtp_host",
  "mail.smtp_port",
  "mail.smtp_user",
  "mail.smtp_password",
  "mail.smtp_secure",
  "mail.sendmail_path",
] as const;

/** The subset of `FormData` the planner reads. */
export type MailFormReader = {
  get(key: string): FormDataEntryValue | null;
  has(key: string): boolean;
};

export type MailSettingWrite = { key: string; value: string | null; label: string };

export type MailSettingsPlan =
  | { ok: false; error: "forbidden" | "validation" }
  | { ok: true; provider: MailProviderName | undefined; writes: MailSettingWrite[] };

function text(form: MailFormReader, key: string): string | undefined {
  const v = form.get(key);
  if (v == null) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/**
 * Plan the plain (non-secret) `mail.*` writes for one save. Secrets are handled
 * by the action (encrypted, only when a new value is typed) — but they are
 * transport fields, so the `forbidden` check here covers them too.
 */
export function planMailSettingsWrites(
  form: MailFormReader,
  opts: {
    /** Actor holds `*` (may change the transport). */
    canEditTransport: boolean;
    /** What provider/from/reply-to resolve to with no DB row (see mailEnvDefaults). */
    defaults: { providerName: string; from: string; replyTo: string | undefined };
    /** True when the env var is set — the matching field is env-locked. */
    envLocked: (envVar: string) => boolean;
  },
): MailSettingsPlan {
  if (!opts.canEditTransport && MAIL_TRANSPORT_FIELDS.some((k) => form.has(k))) {
    return { ok: false, error: "forbidden" };
  }

  const rawProvider = text(form, "mail.provider");
  const provider = parseMailProviderName(rawProvider);
  if (rawProvider !== undefined && !provider) return { ok: false, error: "validation" };

  const candidates: (MailSettingWrite & { envVar?: string })[] = [];
  if (provider) {
    candidates.push({
      key: "mail.provider",
      value: mailSettingToPersist(provider, opts.defaults.providerName, { caseInsensitive: true }),
      label: "Fournisseur email",
    });
  }
  if (form.has("mail.from")) {
    candidates.push({
      key: "mail.from",
      value: mailSettingToPersist(text(form, "mail.from"), opts.defaults.from),
      label: "Expéditeur (From)",
    });
  }
  if (form.has("mail.reply_to")) {
    candidates.push({
      key: "mail.reply_to",
      value: mailSettingToPersist(text(form, "mail.reply_to"), opts.defaults.replyTo),
      label: "Répondre à (Reply-To)",
    });
  }
  if (provider === "smtp") {
    for (const [key, label, envVar] of [
      ["mail.smtp_host", "SMTP — hôte", "SMTP_HOST"],
      ["mail.smtp_port", "SMTP — port", "SMTP_PORT"],
      ["mail.smtp_user", "SMTP — utilisateur", "SMTP_USER"],
    ] as const) {
      if (form.has(key)) candidates.push({ key, value: text(form, key) ?? null, label, envVar });
    }
    // An unchecked checkbox is absent from FormData, so — with the SMTP section
    // rendered (provider === "smtp") — absence means TLS OFF.
    candidates.push({
      key: "mail.smtp_secure",
      value: form.get("mail.smtp_secure") === "on" ? "true" : "false",
      label: "SMTP — TLS",
      envVar: "SMTP_SECURE",
    });
  }
  if (provider === "internal" && form.has("mail.sendmail_path")) {
    candidates.push({
      key: "mail.sendmail_path",
      value: text(form, "mail.sendmail_path") ?? null,
      label: "Mailer interne — chemin sendmail",
      envVar: "SENDMAIL_PATH",
    });
  }

  const writes = candidates
    .filter((c) => !(c.envVar && opts.envLocked(c.envVar))) // env-locked → leave DB alone
    .map(({ key, value, label }) => ({ key, value, label }));
  return { ok: true, provider, writes };
}
