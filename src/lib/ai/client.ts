import "server-only";

import { resolveAiProviderConfig } from "./config";
import { getAiProvider, type AiProvider } from "./providers";
import { assertAiBaseUrlSafe } from "./guard-base-url";
import { providerErrorDetail } from "./provider-error";
import { isReasoningModelId, REASONING_HEADROOM } from "./reasoning-model";

/**
 * The single AI generation chokepoint. Every AI feature calls `generateText`;
 * it resolves live credentials via `resolveAiProviderConfig` (env → encrypted
 * DB → "") and dispatches to the provider's chat endpoint.
 *
 * Two wire formats:
 *   - Anthropic → POST {baseUrl}/v1/messages (x-api-key + anthropic-version)
 *   - everything else (OpenRouter / DeepSeek / OpenAI, all OpenAI-compatible)
 *     → POST {baseUrl}/chat/completions (Authorization: Bearer …)
 *
 * NEVER returns or logs the API key. Errors include the HTTP status but never
 * the credential. A 30s AbortController guards against a hung upstream.
 *
 * `truncated` flags a reply cut by the output-token cap (Anthropic
 * `stop_reason: "max_tokens"`, OpenAI-compatible `finish_reason: "length"`): the
 * text is returned as-is, and the caller decides whether a partial answer is
 * usable (the one-click action refuses it rather than insert half an HTML block).
 */

export type GenerateTextResult =
  | { ok: true; text: string; truncated?: boolean }
  | { ok: false; error: string };

/** Per-provider sane model fallback when neither input nor config supplies one. */
const MODEL_FALLBACK: Record<AiProvider, string> = {
  openrouter: "openai/gpt-4o-mini",
  deepseek: "deepseek-chat",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
};

const TIMEOUT_MS = 30_000;

export async function generateText({
  provider,
  model,
  system,
  prompt,
  temperature,
  maxTokens,
}: {
  provider: string;
  model?: string | null;
  system?: string | null;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<GenerateTextResult> {
  const def = getAiProvider(provider);
  if (!def) return { ok: false, error: `Fournisseur inconnu : ${provider}` };

  const cfg = await resolveAiProviderConfig(def.id);
  if (!cfg.configured) return { ok: false, error: `${def.label} non configuré` };
  if (!cfg.enabled) return { ok: false, error: `${def.label} désactivé` };

  const mdl = model?.trim() || cfg.defaultModel || MODEL_FALLBACK[def.id];
  const sys = system?.trim() || undefined;

  // SSRF guard at REQUEST time (the base URL is admin-saved and carries the
  // decrypted key in a header): re-validate + DNS-resolve and reject link-local /
  // cloud-metadata targets. Combined with redirect:"manual" below, a permitted
  // host can neither BE nor REDIRECT TO the metadata endpoint.
  const baseUrlErr = await assertAiBaseUrlSafe(cfg.baseUrl);
  if (baseUrlErr) return { ok: false, error: `${def.label} : ${baseUrlErr}` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    if (def.id === "anthropic") {
      // Anthropic Messages API — system is a top-level field, not a message.
      const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: mdl,
          max_tokens: maxTokens ?? 1024,
          // Forward the caller's temperature (review-gen uses 0.9, auto-assign
          // 0.1) — it was silently dropped on the Anthropic path before.
          ...(temperature != null ? { temperature } : {}),
          ...(sys ? { system: sys } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
        cache: "no-store",
        // Do NOT follow redirects — a permitted host must not 30x toward an
        // internal/metadata address (a 3xx falls through to the !res.ok branch).
        redirect: "manual",
      });

      if (!res.ok) {
        return { ok: false, error: `${def.label} a répondu ${res.status}${await providerErrorDetail(res)}` };
      }
      const data = await res.json().catch(() => null);
      const text = data?.content?.[0]?.text;
      if (typeof text !== "string" || !text.trim()) {
        return { ok: false, error: `${def.label} : réponse vide` };
      }
      return { ok: true, text: text.trim(), truncated: data?.stop_reason === "max_tokens" };
    }

    // OpenAI-compatible chat completions (OpenRouter / DeepSeek / OpenAI).
    // REASONING models (o-series o1/o3/o4-mini incl. an "openai/o4-mini" OpenRouter id;
    // DeepSeek R1 / "deepseek-reasoner"; any ":thinking" variant) reject `max_tokens`
    // (they require `max_completion_tokens`) and a non-default `temperature` — sending
    // the usual pair returns HTTP 400. They ALSO spend output tokens on HIDDEN reasoning
    // that counts against the SAME cap, so a cap sized for the visible answer alone
    // starves it: the reply comes back empty or truncated (« réponse vide » / refused),
    // worst on the LONGEST field (a product description — the most-reported failure).
    // Fix: emit the reasoning shape AND add headroom so the reasoning doesn't eat the
    // answer's budget; a non-reasoning model keeps the exact answer cap.
    const isReasoningModel = isReasoningModelId(mdl);
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: mdl,
        messages: [
          ...(sys ? [{ role: "system", content: sys }] : []),
          { role: "user", content: prompt },
        ],
        ...(isReasoningModel ? {} : { temperature: temperature ?? 0.7 }),
        ...(maxTokens != null
          ? isReasoningModel
            ? { max_completion_tokens: maxTokens + REASONING_HEADROOM }
            : { max_tokens: maxTokens }
          : {}),
      }),
      signal: controller.signal,
      cache: "no-store",
      // Do NOT follow redirects (see the Anthropic branch above).
      redirect: "manual",
    });

    if (!res.ok) {
      return { ok: false, error: `${def.label} a répondu ${res.status}${await providerErrorDetail(res)}` };
    }
    const data = await res.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      return { ok: false, error: `${def.label} : réponse vide` };
    }
    return { ok: true, text: text.trim(), truncated: data?.choices?.[0]?.finish_reason === "length" };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      error: aborted
        ? `${def.label} : délai dépassé (30s)`
        : `${def.label} : échec de la requête`,
    };
  } finally {
    clearTimeout(timer);
  }
}
