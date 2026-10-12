import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { getAiTask } from "@/lib/ai/tasks";
import {
  ai_feature_prompts,
  type AiFeaturePromptRow,
  type NewAiFeaturePromptRow,
} from "./schema";

/**
 * CRUD on `ai_feature_prompts` (admin overrides for AI generation tasks).
 * Stores rows as-is; the catalog of tasks + strong default prompts lives in
 * `src/lib/ai/tasks.ts`. No business logic here beyond the upsert.
 */
class AiFeaturePromptsService {
  async get(feature: string, task: string): Promise<AiFeaturePromptRow | null> {
    const [row] = await db
      .select()
      .from(ai_feature_prompts)
      .where(
        and(
          eq(ai_feature_prompts.feature, feature),
          eq(ai_feature_prompts.task, task),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async listByFeature(feature: string): Promise<AiFeaturePromptRow[]> {
    return db
      .select()
      .from(ai_feature_prompts)
      .where(eq(ai_feature_prompts.feature, feature));
  }

  /** Upsert one (feature, task) row on the composite primary key. */
  async upsert(input: NewAiFeaturePromptRow): Promise<AiFeaturePromptRow> {
    const [row] = await db
      .insert(ai_feature_prompts)
      .values(input)
      .onConflictDoUpdate({
        target: [ai_feature_prompts.feature, ai_feature_prompts.task],
        set: { ...input, updated_at: sql`now()` },
      })
      .returning();
    return row;
  }
}

export const aiFeaturePromptsService = new AiFeaturePromptsService();

/** Resolved prompt config for one generation task (DB override ∪ code default). */
export type ResolvedFeaturePrompt = {
  feature: string;
  task: string;
  /** The effective system prompt (DB override when set, else the code default). */
  systemPrompt: string;
  /** Provider override (one of AI_PROVIDER_IDS) or null = auto-pick. */
  provider: string | null;
  /** Model override or null = the provider's default model. */
  model: string | null;
  enabled: boolean;
};

/**
 * Resolve a generation task: the DB row (if any) MERGED with the code default
 * from `tasks.ts`. Returns null only for an unknown (feature, task) pair.
 *
 *   systemPrompt = db.system_prompt?.trim()  ||  task.defaultSystemPrompt
 *   provider     = db.provider || null
 *   model        = db.model    || null
 *   enabled      = db.enabled  ?? true
 */
export async function getFeaturePrompt(
  feature: string,
  task: string,
): Promise<ResolvedFeaturePrompt | null> {
  const def = getAiTask(feature, task);
  if (!def) return null;

  const row = await aiFeaturePromptsService.get(feature, task).catch(() => null);

  return {
    feature,
    task,
    systemPrompt: row?.system_prompt?.trim() || def.defaultSystemPrompt,
    provider: row?.provider || null,
    model: row?.model || null,
    enabled: row?.enabled ?? true,
  };
}
