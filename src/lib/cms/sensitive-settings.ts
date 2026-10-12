/**
 * PURE classification of security-relevant `site_settings` keys — NO
 * "server-only", NO DB import, so both the setting workflow (which attaches the
 * before/after values to `setting.upserted`) and the pure severity model
 * (`src/events/severity.ts`, also imported by a client component) share ONE list.
 *
 * A "sensitive" key is one whose change an owner must be able to reconstruct
 * after an incident: it weakens a security control (email verification, the
 * consent banner, the redirects engine, a payment method toggle), takes the
 * shop offline (`site.mode`), re-points the canonical origin (`seo.site_url`),
 * or re-routes customers (contact channels, CTA / link destinations). For those
 * keys the audit row records `from` → `to` and is `warn` severity instead of a
 * name-only `info` row that blends into routine copy edits.
 *
 * Secret-bearing keys (encrypted `*_enc`, passwords, tokens, API keys) are
 * NEVER sensitive-with-values — their values must not reach the audit log or
 * webhooks — even if a prefix below would otherwise match.
 */

/** Exact keys. */
export const SENSITIVE_SETTING_KEYS: ReadonlySet<string> = new Set([
  "seo.site_url",
  "consent.enabled",
  "redirects.enabled",
  "site.mode",
  "site.whatsapp",
]);

/** Whole namespaces (security toggles, payment methods, contact channels). */
const SENSITIVE_PREFIXES = ["auth.", "checkout.payment.", "site.contact_"] as const;

/**
 * Storefront COPY under `auth.*` (login / register / reset page titles, perks,
 * panel text) — editorial, not a security control, so it stays a plain row.
 */
const AUTH_COPY_PREFIXES = [
  "auth.login.",
  "auth.register.",
  "auth.forgot.",
  "auth.reset.",
  "auth.verify.",
] as const;

/** Key names that may hold a secret — never exposed with values. */
export function isSecretSettingKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.endsWith("_enc") ||
    k.includes("password") ||
    k.includes("secret") ||
    k.includes("token") ||
    k.includes("api_key")
  );
}

/**
 * URL-bearing keys (a link / CTA destination or an embed URL): `*.href`,
 * `*_href`, `*_url`. A silently re-pointed CTA is a phishing vector, so the
 * destination change is recorded with its values.
 */
function isUrlBearingKey(key: string): boolean {
  return /(?:^|[._])href$/.test(key) || /_url$/.test(key);
}

/** True when `key` is security-relevant (and not a secret). */
export function isSensitiveSettingKey(key: string): boolean {
  if (isSecretSettingKey(key)) return false;
  if (SENSITIVE_SETTING_KEYS.has(key)) return true;
  if (AUTH_COPY_PREFIXES.some((p) => key.startsWith(p))) return false;
  if (SENSITIVE_PREFIXES.some((p) => key.startsWith(p))) return true;
  return isUrlBearingKey(key);
}
