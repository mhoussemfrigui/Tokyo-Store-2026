/**
 * Reasoning-model detection — PURE (no server-only / no DB) so the client AND
 * its unit test share one definition.
 *
 * A REASONING model (OpenAI o-series o1/o3/o4-mini, incl. an "openai/o4-mini"
 * OpenRouter id; DeepSeek R1 / "deepseek-reasoner"; any ":thinking" variant):
 *   - requires `max_completion_tokens` (NOT `max_tokens`) and rejects a
 *     non-default `temperature` — the usual pair returns HTTP 400;
 *   - spends output tokens on HIDDEN reasoning that counts against the SAME cap,
 *     so a cap sized for the visible answer alone starves it (empty/truncated
 *     reply, worst on the longest field — a product description).
 *
 * MUST NOT false-match common chat models (gpt-4o, gpt-4o-mini, deepseek-chat,
 * claude-3-opus, mistral-large…).
 */
export function isReasoningModelId(model: string): boolean {
  return /(?:^|\/)o\d|reasoner|-r1(?:[-:]|$)|:thinking|\bthinking\b/i.test(model);
}

/** Extra `max_completion_tokens` for a reasoning model so its hidden reasoning
 *  doesn't eat the visible answer's budget. */
export const REASONING_HEADROOM = 3072;
