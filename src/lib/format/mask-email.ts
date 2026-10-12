/**
 * Mask an email's local part to `a***@domain` for display in confirmations /
 * UI ("a code was sent to a***@gmail.com"). Pure + isomorphic — no deps.
 * Returns "" for a value with no usable local part so callers can fall back.
 *
 * Three maskEmail variants coexist on purpose:
 *   - THIS one (format) — UI display: 1 char, NO lowercase, "" fallback so a
 *     caller can substitute a friendly label (e.g. demo-purge → "votre adresse").
 *   - src/lib/email/util.ts — security-event payloads: 1 char, lowercases
 *     (normalised log), "***" fallback (never blank in the audit trail).
 *   - src/lib/telemetry/redact.ts — keeps the first 3 chars for log-grep utility.
 * Keep the fallbacks distinct (callers depend on them); do not naively merge.
 */
export function maskEmail(email: string): string {
  const at = (email ?? "").indexOf("@");
  if (at <= 0) return "";
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}
