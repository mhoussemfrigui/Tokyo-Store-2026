import "server-only";

import nodemailer, { type Transporter } from "nodemailer";

import type { EmailProvider } from "../types";
import { withSendTimeout } from "./send-timeout";

/**
 * "Internal" mailer — the app sends mail itself through the host's LOCAL mail
 * system (nodemailer's bundled sendmail transport), with no third-party relay
 * (Resend) or external SMTP server. Requires a sendmail-compatible binary on
 * the host (Postfix/Exim/ssmtp at `mail.sendmail_path`, default
 * `/usr/sbin/sendmail`). On hosts without a local MTA, prefer SMTP or Resend.
 *
 * Transporter cached per resolved path so changing it in the admin tab rebuilds
 * without a process restart.
 *
 * The sendmail transport spawns the local binary — nodemailer's SMTP
 * connection/greeting/socket timeouts don't apply to it, and a binary that
 * blocks (e.g. an ssmtp relaying to a black-holed host) would otherwise hang
 * the caller forever. The send is raced against PROVIDER_SEND_TIMEOUT_MS
 * instead (the child process itself is left to finish or die on its own).
 */
let cached: { path: string; transporter: Transporter } | null = null;

function transporterFor(path: string): Transporter {
  if (!cached || cached.path !== path) {
    cached = {
      path,
      transporter: nodemailer.createTransport({
        sendmail: true,
        path,
        newline: "unix",
      }),
    };
  }
  return cached.transporter;
}

export const internalProvider: EmailProvider = {
  name: "internal",
  async send(payload, { from, sendmailPath }) {
    const path = sendmailPath?.trim() || "/usr/sbin/sendmail";
    const result = await withSendTimeout(
      transporterFor(path).sendMail({
        from,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
        replyTo: payload.replyTo,
        headers: payload.headers,
      }),
      "sendmail",
    );
    return { id: result.messageId };
  },
};
