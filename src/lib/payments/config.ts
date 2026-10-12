import "server-only";

import { serverEnv } from "@/lib/env";
import { paymentSettingsService } from "@/modules/payment";
import { decryptSecret } from "@/lib/crypto/secrets";
import type { GatewayMethod } from "./shared";

/**
 * Resolve live payment-provider config with ENV-FORCED-OVERRIDE precedence:
 *
 *   value = (env var, when actually set)  ??  (decrypted DB value)  ??  ""
 *
 * A blank/whitespace env var counts as UNSET (Coolify delivers empty dashboard
 * fields as ""), so it falls through to the admin-saved DB value rather than
 * blanking a working credential. `test_mode` follows the same rule and defaults
 * to sandbox.
 *
 * Cached for a short TTL because the payment path hits this on every
 * initiate/verify (return page + webhook). The admin save action calls
 * `invalidatePaymentConfigCache()` so changes apply within seconds regardless.
 */

export type ResolvedClictopay = {
  provider: "clictopay";
  userName: string;
  password: string;
  testMode: boolean;
};
export type ResolvedFlouci = {
  provider: "flouci";
  appToken: string;
  appSecret: string;
  testMode: boolean;
};
export type ResolvedPaymentConfig = ResolvedClictopay | ResolvedFlouci;

const TTL_MS = 30_000;
type Entry = { value: ResolvedPaymentConfig; expires: number };
const cache = new Map<GatewayMethod, Entry>();

function envStr(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}
/**
 * STRICT boolean env parse for the sandbox/test-mode toggle (a money-critical
 * switch). Only an explicit affirmative or negative is honoured; an UNRECOGNIZED
 * value (a typo like `prod`) returns undefined so it falls through to the DB
 * setting / safe default instead of silently forcing SANDBOX — which would
 * "settle" real orders with public test cards. The typo is logged so an operator
 * notices. (Previously "anything not false-ish" meant sandbox.)
 */
export function parseTestModeEnv(v: string | undefined): boolean | undefined {
  const t = v?.trim().toLowerCase();
  if (!t) return undefined;
  if (t === "true" || t === "1" || t === "yes" || t === "on") return true;
  if (t === "false" || t === "0" || t === "no" || t === "off") return false;
  console.warn(`[payments] ignoring unrecognized test-mode env value: "${v}" (expected true/false)`);
  return undefined;
}
/** ENV wins when set; else decrypted DB ciphertext; else "". */
function pick(env: string | undefined, enc: string | null | undefined): string {
  return envStr(env) ?? decryptSecret(enc);
}

export function invalidatePaymentConfigCache(provider?: GatewayMethod): void {
  if (provider) cache.delete(provider);
  else cache.clear();
}

export async function resolvePaymentConfig(provider: "clictopay"): Promise<ResolvedClictopay>;
export async function resolvePaymentConfig(provider: "flouci"): Promise<ResolvedFlouci>;
export async function resolvePaymentConfig(
  provider: GatewayMethod,
): Promise<ResolvedPaymentConfig> {
  const now = Date.now();
  const cached = cache.get(provider);
  if (cached && cached.expires > now) return cached.value;

  const row = await paymentSettingsService.get(provider).catch(() => null);

  let value: ResolvedPaymentConfig;
  if (provider === "clictopay") {
    value = {
      provider: "clictopay",
      userName: pick(serverEnv.CLICTOPAY_USERNAME, row?.username_enc),
      password: pick(serverEnv.CLICTOPAY_PASSWORD, row?.password_enc),
      testMode: parseTestModeEnv(serverEnv.CLICTOPAY_TEST_MODE) ?? row?.test_mode ?? true,
    };
  } else {
    value = {
      provider: "flouci",
      appToken: pick(serverEnv.FLOUCI_APP_TOKEN, row?.app_token_enc),
      appSecret: pick(serverEnv.FLOUCI_APP_SECRET, row?.app_secret_enc),
      // Resolved for union symmetry, but Flouci's v2 client does NOT act on it —
      // env is selected by which credentials you enter. The admin UI hides the
      // sandbox toggle for Flouci accordingly (see providerSupportsTestMode in
      // ./shared). Kept so a future sandbox host can wire it without a migration.
      testMode: parseTestModeEnv(serverEnv.FLOUCI_TEST_MODE) ?? row?.test_mode ?? true,
    };
  }

  cache.set(provider, { value, expires: now + TTL_MS });
  return value;
}
