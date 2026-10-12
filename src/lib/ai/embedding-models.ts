/**
 * Recommended EMBEDDING models per provider for the admin picker (Système → IA & Automation).
 * Every entry produces — or, for the OpenAI 3-series via the `dimensions` param, is
 * reduced to — 1536 dimensions, the fixed size of `products.embedding vector(1536)`
 * (migration 0112). A model of any other dimension is rejected by the chokepoint, so
 * we only ever SUGGEST 1536-compatible ones.
 *
 * OpenRouter model IDs are vendor-prefixed (`openai/…`); OpenAI-direct IDs are bare.
 * Pure data — no server import — so both the client panel and tests can read it.
 */

export type EmbeddingModelSuggestion = {
  /** Exact model id to send to the provider. */
  model: string;
  /** Short French label shown in the datalist option. */
  label: string;
  /** The single default/best pick for that provider (drives the placeholder). */
  recommended?: boolean;
};

export const EMBEDDING_MODEL_SUGGESTIONS: Record<string, EmbeddingModelSuggestion[]> = {
  openrouter: [
    { model: "openai/text-embedding-3-small", label: "OpenAI 3 Small · 1536 · rapide & économique", recommended: true },
    { model: "openai/text-embedding-3-large", label: "OpenAI 3 Large · 1536 (réduit) · qualité +" },
    { model: "openai/text-embedding-ada-002", label: "OpenAI Ada 002 · 1536 · legacy" },
  ],
  openai: [
    { model: "text-embedding-3-small", label: "3 Small · 1536 · rapide & économique", recommended: true },
    { model: "text-embedding-3-large", label: "3 Large · 1536 (réduit) · qualité +" },
    { model: "text-embedding-ada-002", label: "Ada 002 · 1536 · legacy" },
  ],
};

/** The recommended model id for a provider (the placeholder / « laisser vide » default). */
export function recommendedEmbeddingModel(provider: string): string {
  const list = EMBEDDING_MODEL_SUGGESTIONS[provider];
  return (list?.find((m) => m.recommended) ?? list?.[0])?.model ?? "text-embedding-3-small";
}

/**
 * OpenAI text-embedding-3 models accept a `dimensions` param (Matryoshka) to emit a
 * shorter vector — how text-embedding-3-large (native 3072) is reduced to our 1536.
 * Matches the bare and the OpenRouter vendor-prefixed id. Ada-002 does NOT support it
 * (it is natively 1536). A regression here that drops the param for 3-large → provider
 * returns 3072 dims → the chokepoint rejects it → every embed for that model fails
 * silently, so this stays pure + unit-tested. Kept here (pure) rather than in the
 * server-only embed.ts, which re-exports it.
 */
export function supportsDimensionsParam(model: string): boolean {
  return /(^|\/)text-embedding-3-(small|large)\b/i.test(model);
}
