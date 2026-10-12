import { boolean, index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { id, timestamps } from "@/lib/db/columns";

/**
 * AI provider settings — admin-configurable AI/automation credentials.
 *
 * One row per provider (`openrouter` | `deepseek` | `openai` | `anthropic`;
 * see `src/lib/ai/providers.ts`). The `api_key_enc` column holds AES-256-GCM
 * ciphertext (never plaintext at rest — see `src/lib/crypto/secrets.ts`);
 * `base_url` / `default_model` are non-secret hints.
 *
 * Unlike `payment_provider_settings`, the on/off `enabled` flag lives HERE —
 * there is no storefront read for AI providers, so no `site_settings` split.
 *
 * Precedence at read time (`src/lib/ai/config.ts`): a matching ENV var
 * (`OPENROUTER_API_KEY`, …), when set, FORCE-OVERRIDES the stored key;
 * otherwise the decrypted DB value is used.
 */
export const ai_provider_settings = pgTable("ai_provider_settings", {
  provider: text("provider").primaryKey(),

  // AES-256-GCM ciphertext of the API key (never plaintext at rest).
  api_key_enc: text("api_key_enc"),

  // Optional custom endpoint — falls back to the provider's defaultBaseUrl.
  base_url: text("base_url"),
  // Optional default model id used by future AI features.
  default_model: text("default_model"),

  enabled: boolean("enabled").notNull().default(false),

  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type AiProviderSettingsRow = typeof ai_provider_settings.$inferSelect;
export type NewAiProviderSettingsRow = typeof ai_provider_settings.$inferInsert;

/**
 * AI feature prompts — per (feature, task) generation config that powers
 * one-click AI generation (product descriptions, FAQ, SEO, attribution, …).
 *
 * The CODE owns the task catalog + strong French default prompts
 * (`src/lib/ai/tasks.ts`); this table only stores ADMIN OVERRIDES. A blank
 * `system_prompt` falls back to the code default; a null `provider` / `model`
 * means "use the first configured+enabled provider / its default model"
 * (merge logic in `src/modules/ai/feature-service.ts#getFeaturePrompt`).
 *
 * Composite primary key (feature, task) — one row per generation task. Unlike
 * `ai_provider_settings` these values are NON-secret (no encryption, no env
 * override): they're editorial prompts, not credentials.
 */
export const ai_feature_prompts = pgTable(
  "ai_feature_prompts",
  {
    // Feature group id (e.g. "produits"), from AI_FEATURES in tasks.ts.
    feature: text("feature").notNull(),
    // Task id within the feature (e.g. "description_short"), from the feature's
    // tasks in AI_FEATURES (src/lib/ai/tasks.ts).
    task: text("task").notNull(),

    // Optional provider override (one of AI_PROVIDER_IDS). Null = auto-pick.
    provider: text("provider"),
    // Optional model override. Null = the provider's default model.
    model: text("model"),
    // Optional system-prompt override. Null/blank = the code default from tasks.ts.
    system_prompt: text("system_prompt"),

    enabled: boolean("enabled").notNull().default(true),

    ...timestamps(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.feature, t.task] }),
  }),
);

export type AiFeaturePromptRow = typeof ai_feature_prompts.$inferSelect;
export type NewAiFeaturePromptRow = typeof ai_feature_prompts.$inferInsert;

/**
 * AI call log — one append-only row per provider call, powering a future
 * « Journal » sub-tab of Système → IA. Transport-level record: provider, model,
 * status (ok|empty|error), the provider's error message, latency, and whether
 * web search ran — so an operator can diagnose a failure (e.g. an OpenRouter 400)
 * without server logs. Written best-effort by the EMBEDDING chokepoint
 * (`src/lib/ai/embed.ts`) only; the `generateText` chat chokepoint does NOT log
 * yet (the `feature`/`task`/`web_search` columns are provisioned for that future
 * wiring but currently only ever carry the embedding path's values). A logging
 * failure never surfaces in the generation/embedding path. See migration 0111.
 */
export const ai_call_logs = pgTable(
  "ai_call_logs",
  {
    id: id(),
    feature: text("feature"),
    task: text("task"),
    provider: text("provider").notNull(),
    model: text("model"),
    status: text("status").$type<"ok" | "empty" | "error">().notNull(),
    error: text("error"),
    duration_ms: integer("duration_ms").notNull().default(0),
    web_search: boolean("web_search").notNull().default(false),
    actor_user_id: text("actor_user_id"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdIdx: index("ai_call_logs_created_idx").on(t.created_at.desc()),
  }),
);

export type AiCallLogRow = typeof ai_call_logs.$inferSelect;
export type NewAiCallLogRow = typeof ai_call_logs.$inferInsert;
