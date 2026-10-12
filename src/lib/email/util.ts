/**
 * Small helpers shared by the transactional-email triggers.
 */

/** First name from a full name ("Mohamed Frigui" → "Mohamed"). Falls back to a
 *  neutral greeting so a template's "{{ first_name }}" is never blank. */
export function firstNameOf(fullName?: string | null, fallback = "cher client"): string {
  const first = fullName?.trim().split(/\s+/)[0];
  return first && first.length > 0 ? first : fallback;
}

/**
 * Partially mask an email for security-event payloads / the Sécurité log: keep
 * the first local-part char + the full domain ("mohamed@gmail.com" →
 * "m***@gmail.com"). The domain is retained on purpose — it lets an operator spot
 * a credential-stuffing run against one provider without exposing the full
 * address. Pure; safe to log. Lowercases (normalised trail). Returns "***" for an
 * unparseable value (never blank in the audit trail).
 *
 * NOTE: distinct from src/lib/format/mask-email.ts (UI display: no lowercase, ""
 * fallback) and src/lib/telemetry/redact.ts (keeps 3 chars). The "***" fallback
 * here is load-bearing for the security log — do not swap in the format variant.
 */
export function maskEmail(email?: string | null): string {
  const e = (email ?? "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at <= 0 || at === e.length - 1) return "***";
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}
