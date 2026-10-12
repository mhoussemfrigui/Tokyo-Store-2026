import "server-only";

import { serverEnv } from "@/lib/env";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { SmtpRuntimeConfig } from "./types";
import { parseMailProviderName, type MailProviderName } from "./mail-settings";

/**
 * Resolved mail-provider config. Modelled on src/lib/payments/config.ts:
 * for SECRETS (Resend key, SMTP password) an explicitly-set env var WINS over
 * the encrypted DB value (so a deployed env credential is authoritative and a
 * leaked DB never overrides it); the admin-managed DB value is the fallback.
 * Provider name / from / reply-to keep the existing DB-first behaviour (the
 * admin Mailing tab selects them), but the admin save stores NULL for a value
 * equal to the env/default fallback (`mailSettingToPersist` in ./mail-settings),
 * so the environment stays authoritative until an operator deliberately picks
 * something else.
 *
 * Cached for a short TTL so a burst of sends doesn't re-read settings + decrypt
 * each time; invalidated by the save action.
 */
export type ResolvedMailConfig = {
  providerName: MailProviderName;
  from: string;
  replyTo: string | undefined;
  /** "" when not configured. */
  resendApiKey: string;
  smtp: SmtpRuntimeConfig;
  /** Local sendmail binary path for the "internal" provider. */
  sendmailPath: string;
};

const TTL_MS = 30_000;
let cache: { value: ResolvedMailConfig; at: number } | null = null;

export function invalidateMailConfigCache(): void {
  cache = null;
}

/** Trim a raw value to undefined when blank (so `??` falls through). */
function trimmed(v: string | null | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t.length ? t : undefined;
}
/** Explicitly-set env var (blank/unset → undefined), for env-wins precedence. */
function env(name: string): string | undefined {
  return trimmed(process.env[name]);
}
function asBool(v: string | undefined, fb: boolean): boolean {
  if (v == null) return fb;
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;
  return fb;
}

/**
 * What provider / from / reply-to resolve to when NO admin DB row pins them:
 * the environment (EMAIL_PROVIDER / EMAIL_FROM / EMAIL_REPLY_TO) or the
 * built-in default. `providerFromEnv` = EMAIL_PROVIDER is explicitly set.
 */
export function mailEnvDefaults(): {
  providerName: MailProviderName;
  providerFromEnv: boolean;
  from: string;
  replyTo: string | undefined;
} {
  const rawProvider = env("EMAIL_PROVIDER");
  return {
    providerName:
      parseMailProviderName(rawProvider ?? serverEnv.EMAIL_PROVIDER ?? "console") ?? "console",
    providerFromEnv: rawProvider !== undefined,
    from: serverEnv.EMAIL_FROM,
    replyTo: trimmed(serverEnv.EMAIL_REPLY_TO),
  };
}

export async function resolveMailProviderConfig(): Promise<ResolvedMailConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  let s: Record<string, string | null> = {};
  try {
    s = await getSettingsMap();
  } catch {
    // Settings unavailable (cold DB) — fall back to env.
  }

  const defaults = mailEnvDefaults();
  // A DB row (admin Mailing tab) wins; blank → the env/default fallback. An
  // unknown stored name degrades to "console" (never throws on send).
  const pinned = trimmed(s["mail.provider"]);
  const providerName: ResolvedMailConfig["providerName"] =
    pinned !== undefined ? (parseMailProviderName(pinned) ?? "console") : defaults.providerName;

  const value: ResolvedMailConfig = {
    providerName,
    from: trimmed(s["mail.from"]) ?? defaults.from,
    replyTo: trimmed(s["mail.reply_to"]) ?? defaults.replyTo,
    // Secrets: env WINS over encrypted DB.
    resendApiKey: env("RESEND_API_KEY") ?? decryptSecret(s["mail.resend_api_key_enc"]),
    smtp: {
      host: env("SMTP_HOST") ?? trimmed(s["mail.smtp_host"]) ?? "",
      port: Number(env("SMTP_PORT") ?? trimmed(s["mail.smtp_port"]) ?? "587") || 587,
      user: env("SMTP_USER") ?? trimmed(s["mail.smtp_user"]) ?? "",
      pass: env("SMTP_PASSWORD") ?? decryptSecret(s["mail.smtp_password_enc"]),
      secure: asBool(env("SMTP_SECURE") ?? trimmed(s["mail.smtp_secure"]), false),
    },
    sendmailPath:
      env("SENDMAIL_PATH") ?? trimmed(s["mail.sendmail_path"]) ?? "/usr/sbin/sendmail",
  };

  cache = { value, at: Date.now() };
  return value;
}
