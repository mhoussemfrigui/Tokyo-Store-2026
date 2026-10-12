/**
 * Narrow a `getSettingsMap()` result to the key prefixes one admin panel reads.
 *
 * `getSettingsMap()` returns the WHOLE `site_settings` table — which also holds
 * other panels' encrypted secrets (`mail.*_enc`), the SMTP identity, unpublished
 * promo codes (`mail.birthday_code`, `newsletter.welcome_code`) and owner-only
 * tracking snippets. Forwarding the raw map to a "use client" panel serialises
 * all of it into the RSC payload of a role that only holds that panel's `view`
 * grant. Pages pass ONLY their own prefixes through this helper instead.
 *
 * Pure (no server-only import) so it can be unit-tested. Prefixes are matched
 * with `startsWith`, so pass them WITH their trailing dot (`"home."`, not
 * `"home"`, which would also match a `homepage.*` key).
 *
 * Defense-in-depth: a secret-bearing key (`*_enc`, password/secret/token/api_key)
 * is ALWAYS stripped, even if a caller's prefix would match it — so a mistaken
 * prefix can never serialise a credential into a client panel's RSC payload.
 */
import { isSecretSettingKey } from "@/lib/cms/sensitive-settings";

export function pickSettings<V>(
  map: Record<string, V>,
  prefixes: readonly string[],
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const [key, value] of Object.entries(map)) {
    if (isSecretSettingKey(key)) continue;
    if (prefixes.some((p) => key.startsWith(p))) out[key] = value;
  }
  return out;
}
