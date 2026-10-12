import "server-only";

import { resolveMailProviderConfig } from "./config";
import { consoleProvider } from "./providers/console";
import { resendProvider } from "./providers/resend";
import { smtpProvider } from "./providers/smtp";
import { internalProvider } from "./providers/internal";
import type { EmailPayload, EmailProvider } from "./types";

/**
 * Provider-agnostic `send()`.
 *
 * Everything is resolved at SEND TIME via `resolveMailProviderConfig`
 * (./config): provider / from / reply-to are DB-first (`mail.*` settings,
 * managed in the admin Mailing tab) with env fallback; SECRETS (Resend key,
 * SMTP password) are env-WINS with the encrypted DB value (`*_enc` settings)
 * as fallback. So switching provider or rotating a credential needs no
 * redeploy, and a deployed env credential stays authoritative.
 *
 * Errors NEVER bubble into user-facing flows — callers treat send as best-
 * effort (a failed welcome email must not block signup).
 */

const PROVIDERS: Record<string, EmailProvider> = {
  resend: resendProvider,
  smtp: smtpProvider,
  internal: internalProvider,
  console: consoleProvider,
};

export async function sendEmail(
  payload: EmailPayload,
): Promise<{ id: string; provider: string; from: string }> {
  const cfg = await resolveMailProviderConfig();
  const provider = PROVIDERS[cfg.providerName] ?? consoleProvider;
  const res = await provider.send(
    { ...payload, replyTo: payload.replyTo ?? cfg.replyTo },
    {
      from: cfg.from,
      resendApiKey: cfg.resendApiKey,
      smtp: cfg.smtp,
      sendmailPath: cfg.sendmailPath,
    },
  );
  // Surface the resolved provider + from so the caller (dispatch) can log the
  // send accurately without re-resolving the config.
  return { id: res.id, provider: cfg.providerName, from: cfg.from };
}
