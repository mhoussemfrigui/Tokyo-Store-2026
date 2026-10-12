/**
 * PURE unit test for the embedding-model picker data + helpers. No DB, no
 * server-only — runs in the `test:pure` chain.
 *
 *   npx tsx --conditions=react-server src/lib/db/tests/embedding-models.test.ts
 *
 * Pins two invariants that are otherwise only asserted in comments:
 *  1. the picker placeholder (recommendedEmbeddingModel) + the 1536-safety of every
 *     suggestion — a wrong suggestion would let an admin pick a non-1536 model that
 *     the chokepoint then rejects;
 *  2. supportsDimensionsParam — the gate that reduces text-embedding-3-large (3072)
 *     to our 1536; a regex regression drops the param → 3072 dims → silent embed fail.
 */
import {
  EMBEDDING_MODEL_SUGGESTIONS,
  recommendedEmbeddingModel,
  supportsDimensionsParam,
} from "@/lib/ai/embedding-models";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// A suggested model is 1536-safe iff it accepts the dimensions param (3-series) OR is
// natively 1536 (ada-002). Mirrors the chokepoint's accept rule.
const is1536Safe = (model: string) =>
  supportsDimensionsParam(model) || /(^|\/)text-embedding-ada-002$/i.test(model);

function main() {
  console.log("exactly one recommended per provider:");
  for (const [provider, list] of Object.entries(EMBEDDING_MODEL_SUGGESTIONS)) {
    check(
      `${provider}: exactly one recommended:true`,
      list.filter((m) => m.recommended).length === 1,
    );
    check(`${provider}: non-empty suggestion list`, list.length > 0);
  }

  console.log("vendor prefixing (OpenRouter prefixed, OpenAI bare):");
  check(
    "every OpenRouter suggestion is vendor-prefixed (openai/…)",
    EMBEDDING_MODEL_SUGGESTIONS.openrouter.every((m) => m.model.startsWith("openai/")),
  );
  check(
    "every OpenAI-direct suggestion is a bare id (no slash)",
    EMBEDDING_MODEL_SUGGESTIONS.openai.every((m) => !m.model.includes("/")),
  );

  console.log("every suggested model is 1536-safe:");
  for (const [provider, list] of Object.entries(EMBEDDING_MODEL_SUGGESTIONS)) {
    check(
      `${provider}: all suggestions 1536-safe`,
      list.every((m) => is1536Safe(m.model)),
    );
  }

  console.log("recommendedEmbeddingModel:");
  check(
    "openrouter → openai/text-embedding-3-small",
    recommendedEmbeddingModel("openrouter") === "openai/text-embedding-3-small",
  );
  check("openai → text-embedding-3-small", recommendedEmbeddingModel("openai") === "text-embedding-3-small");
  check(
    "unknown provider → text-embedding-3-small fallback",
    recommendedEmbeddingModel("anthropic") === "text-embedding-3-small",
  );
  check(
    "empty provider → text-embedding-3-small fallback",
    recommendedEmbeddingModel("") === "text-embedding-3-small",
  );
  check(
    "recommended pick is itself 1536-safe for every provider",
    Object.keys(EMBEDDING_MODEL_SUGGESTIONS).every((p) => is1536Safe(recommendedEmbeddingModel(p))),
  );

  console.log("supportsDimensionsParam (the 3-series → 1536 reducer gate):");
  check("bare text-embedding-3-small → true", supportsDimensionsParam("text-embedding-3-small"));
  check("bare text-embedding-3-large → true", supportsDimensionsParam("text-embedding-3-large"));
  check(
    "prefixed openai/text-embedding-3-small → true",
    supportsDimensionsParam("openai/text-embedding-3-small"),
  );
  check(
    "prefixed openai/text-embedding-3-large → true",
    supportsDimensionsParam("openai/text-embedding-3-large"),
  );
  check("ada-002 → false (natively 1536, no param)", !supportsDimensionsParam("text-embedding-ada-002"));
  check(
    "prefixed ada-002 → false",
    !supportsDimensionsParam("openai/text-embedding-ada-002"),
  );
  check("unrelated model → false", !supportsDimensionsParam("mistral-embed"));
  check("empty → false", !supportsDimensionsParam(""));
  // Guard against a loose regex matching a substring mid-token.
  check(
    "no false match on a lookalike token",
    !supportsDimensionsParam("xtext-embedding-3-smallish"),
  );

  console.log(`\nembedding-models.test.ts — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main();
