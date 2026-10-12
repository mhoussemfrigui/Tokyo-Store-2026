import { AI_PROVIDERS, type AiProvider } from "./providers";

/**
 * Suggested model ids per provider — powers the model `<datalist>` pickers in
 * the AI & Automation admin (per-provider default model + per-task override).
 *
 * These are SUGGESTIONS, not an enum: the model field stays free-text, so any
 * id the provider supports can be typed even if it's not listed here. Keep the
 * lists short and current; the resolver/client never validates against them.
 */
export const AI_MODEL_SUGGESTIONS: Record<AiProvider, string[]> = {
  openrouter: [
    "openai/gpt-4o-mini",
    "openai/gpt-4o",
    "anthropic/claude-3.5-sonnet",
    "anthropic/claude-3.5-haiku",
    "google/gemini-2.0-flash-001",
    "deepseek/deepseek-chat",
    "meta-llama/llama-3.3-70b-instruct",
  ],
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1", "o4-mini"],
  anthropic: [
    "claude-3-5-haiku-latest",
    "claude-3-5-sonnet-latest",
    "claude-3-7-sonnet-latest",
  ],
};

/** DOM id of a provider's suggestion `<datalist>` (used when the provider is fixed). */
export const modelDatalistId = (provider: string) => `ai-models-${provider}`;

/** DOM id of the merged "all providers" suggestion `<datalist>`. */
export const ALL_MODELS_DATALIST_ID = "ai-models-all";

/** Flattened [{ model, providerLabel }] across every provider, for the merged datalist. */
export const AI_MODEL_OPTIONS: { model: string; providerLabel: string }[] =
  AI_PROVIDERS.flatMap((p) =>
    AI_MODEL_SUGGESTIONS[p.id].map((model) => ({ model, providerLabel: p.label })),
  );
