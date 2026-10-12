/**
 * Email primitives — provider-agnostic.
 *
 * Templates produce `EmailPayload`, providers consume it. Adding a provider
 * = implementing `EmailProvider`. Adding a template = exporting a function
 * returning `EmailPayload` from `templates/`.
 */

export type EmailPayload = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /**
   * Extra RFC 5322 headers, forwarded verbatim by every real provider — today the
   * marketing `List-Unsubscribe` + `List-Unsubscribe-Post` pair (RFC 8058 one-click,
   * see `@/lib/email/list-unsubscribe`). Values must be ASCII, one line each.
   */
  headers?: Record<string, string>;
};

export type SmtpRuntimeConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: boolean;
};

export type EmailSendOpts = {
  from: string;
  /** Resolved Resend API key (env wins → encrypted DB). Empty when not configured. */
  resendApiKey?: string;
  /** Resolved SMTP transport config (env wins → DB). */
  smtp?: SmtpRuntimeConfig;
  /** Path to the local sendmail binary for the "internal" provider. */
  sendmailPath?: string;
};

export type EmailProvider = {
  name: "resend" | "smtp" | "console" | "internal";
  send(payload: EmailPayload, opts: EmailSendOpts): Promise<{ id: string }>;
};
