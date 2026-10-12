/**
 * AI provider catalog — the SINGLE source of truth shared by the admin page,
 * the config resolver, and any future AI/automation wiring.
 *
 * Each entry declares the env var that FORCE-OVERRIDES the DB-stored key
 * (see `src/lib/ai/config.ts`), the default API base URL (used when the admin
 * leaves the custom base URL blank), a docs link, and a short hint for the key
 * format. Extend this array to onboard a new provider — the schema, resolver,
 * action and admin UI all iterate it, so nothing else needs a hard-coded list.
 */

export const AI_PROVIDERS = [
  {
    id: "openrouter",
    label: "OpenRouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    docsUrl: "https://openrouter.ai/keys",
    keyHint: "Clé sk-or-… depuis openrouter.ai/keys.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    defaultBaseUrl: "https://api.deepseek.com",
    docsUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "Clé sk-… depuis platform.deepseek.com.",
  },
  {
    id: "openai",
    label: "OpenAI",
    apiKeyEnv: "OPENAI_API_KEY",
    defaultBaseUrl: "https://api.openai.com/v1",
    docsUrl: "https://platform.openai.com/api-keys",
    keyHint: "Clé sk-… depuis platform.openai.com/api-keys.",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    defaultBaseUrl: "https://api.anthropic.com",
    docsUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "Clé sk-ant-… depuis console.anthropic.com.",
  },
] as const;

export type AiProviderDef = (typeof AI_PROVIDERS)[number];

/** Union of the supported provider ids: "openrouter" | "deepseek" | "openai" | "anthropic". */
export type AiProvider = AiProviderDef["id"];

/** Flat list of provider ids, for zod enums / iteration. */
export const AI_PROVIDER_IDS = AI_PROVIDERS.map((p) => p.id) as [
  AiProvider,
  ...AiProvider[],
];

/** Lookup a provider definition by id (returns undefined for unknown ids). */
export function getAiProvider(id: string): AiProviderDef | undefined {
  return AI_PROVIDERS.find((p) => p.id === id);
}
