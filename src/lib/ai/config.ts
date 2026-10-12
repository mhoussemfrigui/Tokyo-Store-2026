import "server-only";

import { aiProviderSettingsService } from "@/modules/ai";
import type { AiProviderSettingsRow } from "@/modules/ai/schema";
import { decryptSecret } from "@/lib/crypto/secrets";
import { AI_PROVIDERS, getAiProvider, type AiProvider } from "./providers";
import { normalizeAiBaseUrl } from "./validate-base-url";

/**
 * Single cached chokepoint that resolves live AI-provider config — every AI /
 * automation feature should read its credentials through `resolveAiProviderConfig`
 * rather than touching env or the DB directly.
 *
 * Precedence (ENV-FORCED-OVERRIDE, mirrors `src/lib/payments/config.ts`):
 *
 *   apiKey = (env var, when actually set)  ??  (decrypted DB value)  ??  ""
 *
 * A blank/whitespace env var counts as UNSET (Coolify delivers empty dashboard
 * fields as ""), so it falls through to the admin-saved DB value rather than
 * blanking a working credential. `baseUrl` falls back to the provider's
 * `defaultBaseUrl` and is always returned WITHOUT a trailing slash (a legacy row
 * saved as `…/v1/` would otherwise build `…/v1//chat/completions`);
 * `defaultModel` to "".
 *
 * Cached for a short TTL; the admin save action calls `invalidateAiConfigCache()`
 * so changes apply within seconds regardless.
 */

export type ResolvedAiConfig = {
  provider: AiProvider;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  enabled: boolean;
  /** true when an API key resolved from env or DB. */
  configured: boolean;
  /** Where the key came from. */
  source: "env" | "admin" | "none";
};

/** Non-secret status row for the admin page — booleans/strings only, NEVER the key. */
export type AiProviderStatus = {
  id: AiProvider;
  label: string;
  configured: boolean;
  source: "env" | "admin" | "none";
  enabled: boolean;
  baseUrl: string;
  defaultModel: string;
  /** true when the provider's apiKeyEnv var is set (field is locked in the UI). */
  envLocked: boolean;
};

const TTL_MS = 30_000;
type Entry = { value: ResolvedAiConfig; expires: number };
const cache = new Map<AiProvider, Entry>();

/** A blank/whitespace env var counts as UNSET. */
function envStr(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export function invalidateAiConfigCache(provider?: AiProvider): void {
  if (provider) cache.delete(provider);
  else cache.clear();
}

function resolveFrom(
  def: (typeof AI_PROVIDERS)[number],
  row: AiProviderSettingsRow | null,
): ResolvedAiConfig {
  const env = envStr(process.env[def.apiKeyEnv]);
  const dbKey = decryptSecret(row?.api_key_enc);
  const apiKey = env ?? dbKey;
  const source: ResolvedAiConfig["source"] = env
    ? "env"
    : row?.api_key_enc
      ? "admin"
      : "none";
  return {
    provider: def.id,
    apiKey,
    baseUrl: normalizeAiBaseUrl(row?.base_url) || normalizeAiBaseUrl(def.defaultBaseUrl),
    defaultModel: row?.default_model || "",
    // An admin-saved provider honours its explicit `enabled` toggle. But a key
    // supplied purely via ENV var (no DB row) should work OUT OF THE BOX —
    // setting `ANTHROPIC_API_KEY` is itself the intent to use it. Without this,
    // an env-only key resolved `enabled:false` and the AI buttons stayed
    // hidden/disabled ("AI doesn't work") with no obvious cause. A DB row, when
    // present, still wins (so an admin can explicitly disable an env-keyed one).
    enabled: row?.enabled ?? source === "env",
    configured: apiKey.length > 0,
    source,
  };
}

export async function resolveAiProviderConfig(
  provider: AiProvider,
): Promise<ResolvedAiConfig> {
  const def = getAiProvider(provider);
  if (!def) throw new Error(`Unknown AI provider: ${provider}`);

  const now = Date.now();
  const cached = cache.get(provider);
  if (cached && cached.expires > now) return cached.value;

  const row = await aiProviderSettingsService.get(provider).catch(() => null);
  const value = resolveFrom(def, row);
  cache.set(provider, { value, expires: now + TTL_MS });
  return value;
}

/**
 * Per-provider non-secret status for the admin page. NEVER returns the key —
 * only whether one is present, where it came from, and the non-secret hints.
 *
 * Fail-soft by default (a read error resolves every provider from env only —
 * right for the runtime gates below). `{ strict: true }` THROWS instead: the
 * admin pages pre-fill the provider form from this, and a degraded read
 * (enabled:false, no model) would be persisted over the live config by a normal
 * save — a throw reaches the admin error boundary (retry) instead.
 */
export async function listAiProviderStatus(
  opts: { strict?: boolean } = {},
): Promise<AiProviderStatus[]> {
  const rows = opts.strict
    ? await aiProviderSettingsService.listAll()
    : await aiProviderSettingsService.listAll().catch(() => []);
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return AI_PROVIDERS.map((def) => {
    const resolved = resolveFrom(def, byProvider.get(def.id) ?? null);
    return {
      id: def.id,
      label: def.label,
      configured: resolved.configured,
      source: resolved.source,
      enabled: resolved.enabled,
      baseUrl: resolved.baseUrl,
      defaultModel: resolved.defaultModel,
      envLocked: Boolean(envStr(process.env[def.apiKeyEnv])),
    };
  });
}

/**
 * True when at least one provider has a key AND is enabled — i.e. the
 * generation action has SOMETHING to fall back to. Used as a coarse UX gate
 * so the editor can disable the one-click "Générer (IA)" buttons (with a hint)
 * when no provider is ready. The action re-validates per-task regardless.
 */
export async function hasReadyAiProvider(): Promise<boolean> {
  const statuses = await listAiProviderStatus().catch(() => []);
  return statuses.some((s) => s.configured && s.enabled);
}
