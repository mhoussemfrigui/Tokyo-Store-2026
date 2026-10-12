import "server-only";

import { resolveAiProviderConfig, listAiProviderStatus } from "./config";
import { getAiProvider } from "./providers";
import { supportsDimensionsParam } from "./embedding-models";
import { assertAiBaseUrlSafe } from "./guard-base-url";
import { providerErrorDetail } from "./provider-error";
import { aiCallLogService } from "@/modules/ai/call-log.service";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { asStr } from "@/lib/cms/setting-coerce";

/**
 * The single EMBEDDING chokepoint — the vector analogue of `generateText`.
 * Reuses the same AI & Automation provider config (env → encrypted DB key via
 * `resolveAiProviderConfig`), the same SSRF base-url guard, and the same
 * `ai_call_logs` journal. Semantic search calls this to turn a product's text
 * (and a shopper's query) into a 1536-dim vector.
 *
 * Only OpenAI-compatible providers expose `/embeddings` (OpenAI, and OpenRouter /
 * DeepSeek which proxy the same wire format); Anthropic has NO embeddings endpoint,
 * so it's rejected. NEVER returns or logs the API key.
 *
 * Two entry points, one wire path: {@link generateEmbedding} for a single text (a
 * search query, one product) and {@link generateEmbeddings} for a batch (the
 * backfill — one API call embeds up to {@link MAX_EMBEDDING_BATCH} products).
 */

/** OpenAI text-embedding-3-small dimension — MUST match products.embedding vector(N)
 *  in migration 0112. A model returning a different dimension is rejected. */
export const EMBEDDING_DIM = 1536;
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

/**
 * Providers with a confirmed OpenAI-compatible POST /embeddings. OpenRouter is
 * first-class (it proxies OpenAI/Google/… embeddings behind one key) and OpenAI-direct
 * is the fallback. Anthropic has no embeddings endpoint; DeepSeek's is unconfirmed
 * (and its base URL lacks the /v1 embeddings path) — both excluded so the UI only
 * offers providers that actually work.
 */
export const EMBEDDING_CAPABLE_PROVIDERS = new Set(["openrouter", "openai"]);

/**
 * Default embedding model per provider — all produce (or, for the 3-series via the
 * `dimensions` param below, are reduced to) {@link EMBEDDING_DIM}. OpenRouter model
 * IDs are vendor-prefixed (`openai/…`), so a bare `text-embedding-3-small` would 404
 * there — the prefix is required.
 */
export function defaultEmbeddingModelFor(provider?: string | null): string {
  return provider === "openrouter" ? "openai/text-embedding-3-small" : DEFAULT_EMBEDDING_MODEL;
}

/** `supportsDimensionsParam` is a PURE helper — defined in ./embedding-models (unit-
 *  tested there), imported above for use at the request builder and re-exported here so
 *  the chokepoint's existing importers are unchanged. */
export { supportsDimensionsParam };

/** Hard cap on batch size — bounds one request's payload/latency (OpenAI itself
 *  allows more, but small batches keep each call well under the timeout). */
export const MAX_EMBEDDING_BATCH = 128;

const TIMEOUT_MS = 60_000;

export type EmbeddingResult = { ok: true; embedding: number[] } | { ok: false; error: string };
export type EmbeddingBatchResult = { ok: true; embeddings: number[][] } | { ok: false; error: string };

/**
 * Which provider to embed with: the admin-set `ai.embedding_provider` when it's a
 * configured + enabled embedding-capable provider, else the first configured +
 * enabled embedding-capable provider (mirrors the chat-provider fallback). Null when
 * none is ready.
 */
async function resolveEmbeddingProvider(settings: Record<string, string | null>): Promise<string | null> {
  const chosen = asStr(settings["ai.embedding_provider"], "").trim();
  const statuses = await listAiProviderStatus().catch(() => []);
  if (chosen && EMBEDDING_CAPABLE_PROVIDERS.has(chosen)) {
    const s = statuses.find((x) => x.id === chosen);
    if (s?.configured && s.enabled) return chosen;
  }
  return statuses.find((s) => s.configured && s.enabled && EMBEDDING_CAPABLE_PROVIDERS.has(s.id))?.id ?? null;
}

/** The embedding model in effect: the admin `ai.embedding_model` override, else the
 *  per-provider default (pass the resolved provider so an OpenRouter default gets the
 *  vendor prefix). */
export async function resolveEmbeddingModel(provider?: string | null): Promise<string> {
  const s = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  const set = asStr(s["ai.embedding_model"], "").trim();
  return set || defaultEmbeddingModelFor(provider);
}

/** Resolve the provider AND its model together — the single source the chokepoint +
 *  pipeline share, so the model that EMBEDS a product is the model that FINGERPRINTS it.
 *  Null when no embedding provider is configured. */
export async function resolveEmbeddingTarget(): Promise<{ provider: string; model: string } | null> {
  const s = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  const provider = await resolveEmbeddingProvider(s);
  if (!provider) return null;
  const set = asStr(s["ai.embedding_model"], "").trim();
  return { provider, model: set || defaultEmbeddingModelFor(provider) };
}

/** Whether an embedding-capable provider is configured + enabled — so the admin can
 *  tell the operator to set one up before offering « Vectoriser le catalogue ». */
export async function hasEmbeddingProvider(): Promise<boolean> {
  const s = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  return (await resolveEmbeddingProvider(s)) !== null;
}

/**
 * Embed one text into a {@link EMBEDDING_DIM}-dim vector. Best-effort + never throws:
 * returns `{ok:false}` (no provider / API error / wrong dimension / timeout) so callers
 * degrade gracefully (skip that product, or fall back to keyword search).
 */
export async function generateEmbedding(
  text: string,
  opts: { actorUserId?: string | null } = {},
): Promise<EmbeddingResult> {
  const input = text.replace(/\s+/g, " ").trim();
  if (!input) return { ok: false, error: "Texte vide" };
  const batch = await generateEmbeddings([input], opts);
  if (!batch.ok) return batch;
  const embedding = batch.embeddings[0];
  if (!embedding) return { ok: false, error: "Réponse d'embedding vide" };
  return { ok: true, embedding };
}

/**
 * Embed a BATCH of texts in one API call → one vector per input, in order. Best-effort
 * + never throws. Returns `{ok:false}` (no provider / API error / count or dimension
 * mismatch / timeout) so the backfill can retry or record the failure. Rejects an empty
 * batch or one over {@link MAX_EMBEDDING_BATCH}. Logs one `ai_call_logs` row per call.
 */
export async function generateEmbeddings(
  texts: string[],
  opts: { actorUserId?: string | null } = {},
): Promise<EmbeddingBatchResult> {
  const inputs = texts.map((t) => t.replace(/\s+/g, " ").trim());
  if (inputs.length === 0) return { ok: false, error: "Lot vide" };
  if (inputs.length > MAX_EMBEDDING_BATCH) return { ok: false, error: `Lot trop grand (max ${MAX_EMBEDDING_BATCH})` };
  if (inputs.some((t) => t.length === 0)) return { ok: false, error: "Le lot contient un texte vide" };

  const target = await resolveEmbeddingTarget();
  if (!target) return { ok: false, error: "Aucun fournisseur d'embeddings configuré" };
  const { provider, model } = target;

  const start = Date.now();
  const res = await runEmbeddings(provider, model, inputs);
  void aiCallLogService.append({
    feature: "search",
    task: "embedding",
    provider,
    model,
    status: res.ok ? "ok" : "error",
    error: res.ok ? null : res.error,
    duration_ms: Date.now() - start,
    web_search: false,
    actor_user_id: opts.actorUserId ?? null,
  });
  return res;
}

async function runEmbeddings(provider: string, model: string, inputs: string[]): Promise<EmbeddingBatchResult> {
  const def = getAiProvider(provider);
  if (!def) return { ok: false, error: `Fournisseur inconnu : ${provider}` };
  if (def.id === "anthropic") return { ok: false, error: "Anthropic ne fournit pas d'embeddings" };

  const cfg = await resolveAiProviderConfig(def.id);
  if (!cfg.configured) return { ok: false, error: `${def.label} non configuré` };
  if (!cfg.enabled) return { ok: false, error: `${def.label} désactivé` };

  const baseUrlErr = await assertAiBaseUrlSafe(cfg.baseUrl);
  if (baseUrlErr) return { ok: false, error: `${def.label} : ${baseUrlErr}` };

  // Request the exact column dimension from Matryoshka-capable models (OpenAI 3-series),
  // so text-embedding-3-large (native 3072) comes back as our 1536; a no-op for
  // 3-small. Omitted for other models (native 1536, or rejected by the dim check).
  const body: Record<string, unknown> = { model, input: inputs };
  if (supportsDimensionsParam(model)) body.dimensions = EMBEDDING_DIM;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.baseUrl}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
      redirect: "manual",
    });
    if (!res.ok) {
      return { ok: false, error: `${def.label} a répondu ${res.status}${await providerErrorDetail(res)}` };
    }
    const data = (await res.json().catch(() => null)) as
      | { data?: { index?: number; embedding?: unknown }[] }
      | null;
    const items = data?.data;
    if (!Array.isArray(items) || items.length !== inputs.length) {
      return { ok: false, error: `${def.label} : ${items?.length ?? 0} embedding(s) pour ${inputs.length} texte(s)` };
    }
    // Order defensively by `index` (the API returns it; don't assume array order).
    const ordered = [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const embeddings: number[][] = [];
    for (const it of ordered) {
      const emb = it.embedding;
      if (!Array.isArray(emb) || emb.length === 0) {
        return { ok: false, error: `${def.label} : réponse d'embedding illisible` };
      }
      if (emb.length !== EMBEDDING_DIM) {
        return { ok: false, error: `${def.label} : dimension ${emb.length} ≠ ${EMBEDDING_DIM} attendue (modèle ${model})` };
      }
      embeddings.push((emb as unknown[]).map((n) => Number(n)));
    }
    return { ok: true, embeddings };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted ? `${def.label} : délai dépassé (${Math.round(TIMEOUT_MS / 1000)}s)` : `${def.label} : échec de la requête`,
    };
  } finally {
    clearTimeout(timer);
  }
}
