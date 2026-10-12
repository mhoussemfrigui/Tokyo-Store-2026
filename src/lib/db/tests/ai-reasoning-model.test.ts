/**
 * Reasoning-model detection — the AI client routes reasoning models to
 * `max_completion_tokens` + headroom (no `temperature`), and every other model
 * to the standard `max_tokens` + `temperature`. A FALSE POSITIVE would strip
 * temperature + inflate the cap on a normal chat model; a FALSE NEGATIVE sends
 * `max_tokens`/`temperature` to a reasoner → HTTP 400 and starves the answer
 * (the product-description « échec » this guards). Pure — no DB/provider.
 *
 * Run: pnpm exec tsx src/lib/db/tests/ai-reasoning-model.test.ts
 */
import { isReasoningModelId, REASONING_HEADROOM } from "@/lib/ai/reasoning-model";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

// REASONING models → must be detected.
const REASONING = [
  "o1",
  "o1-mini",
  "o3-mini",
  "o4-mini",
  "openai/o4-mini",
  "openai/o3-mini-high",
  "deepseek-reasoner",
  "deepseek-r1",
  "deepseek/deepseek-r1",
  "deepseek/deepseek-r1-0528",
  "anthropic/claude-3.7-sonnet:thinking",
  "qwen/qwq-32b:thinking",
];

// COMMON chat models → must NOT be flagged (no temperature stripping / cap inflation).
const CHAT = [
  "gpt-4o",
  "gpt-4o-mini",
  "openai/gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-4.1",
  "deepseek-chat",
  "deepseek/deepseek-chat",
  "claude-3-5-haiku-latest",
  "claude-3-5-sonnet-latest",
  "claude-3-opus-20240229",
  "mistral-large-latest",
  "meta-llama/llama-3.1-70b-instruct",
  "google/gemini-2.0-flash",
];

for (const m of REASONING) check(`reasoning detected: ${m}`, isReasoningModelId(m) === true);
for (const m of CHAT) check(`chat NOT flagged: ${m}`, isReasoningModelId(m) === false);
check("headroom is a sane positive budget", Number.isInteger(REASONING_HEADROOM) && REASONING_HEADROOM >= 1024);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
