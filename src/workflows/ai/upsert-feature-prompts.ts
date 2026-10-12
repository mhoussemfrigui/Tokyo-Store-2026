import "server-only";

import { z } from "zod";

import { aiFeaturePromptsService } from "@/modules/ai";
import type { NewAiFeaturePromptRow } from "@/modules/ai/schema";
import { AI_PROVIDER_IDS } from "@/lib/ai/providers";
import { getAiTask } from "@/lib/ai/tasks";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Persist ONE (feature, task) AI generation prompt: an optional provider
 * override, model override, system-prompt override, and the on/off flag.
 *
 * These are NON-secret editorial values (no encryption, no env override). A
 * blank provider/model/prompt is stored as NULL so the read-time merge
 * (`getFeaturePrompt`) falls back to the auto-picked provider / default model /
 * code-default prompt in `src/lib/ai/tasks.ts`. A submitted prompt IDENTICAL to
 * the code default is also stored as NULL: pinning today's default as an
 * "override" would silently freeze every later improvement shipped in tasks.ts.
 *
 * A save that changes nothing (same stored values — or, with no row yet, the
 * all-defaults state) writes nothing; a real change emits
 * `ai.feature_prompts_updated` so prompt edits land in the audit journal.
 */

const schema = z.object({
  feature: z.string().min(1),
  task: z.string().min(1),
  // Empty string = "Par défaut" (auto-pick) → stored as null.
  provider: z.union([z.enum(AI_PROVIDER_IDS), z.literal("")]).optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  enabled: z.boolean().optional(),
});

/** Browsers submit textarea line breaks as CRLF — compare/store them as LF. */
const normalizePrompt = (s: string | null | undefined): string =>
  (s ?? "").replace(/\r\n?/g, "\n").trim();

export const upsertAiFeaturePromptsWorkflow = workflow<
  [z.input<typeof schema>, { actorUserId: string }],
  { feature: string; task: string; changedFields: string[] }
>("ai.upsert_feature_prompts", async (input, { actorUserId }) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const { feature, task, provider, model, systemPrompt, enabled } = parsed.data;

  const prompt = normalizePrompt(systemPrompt);
  const codeDefault = normalizePrompt(getAiTask(feature, task)?.defaultSystemPrompt);
  const row: NewAiFeaturePromptRow = {
    feature,
    task,
    provider: provider?.trim() ? provider.trim() : null,
    model: model?.trim() ? model.trim() : null,
    system_prompt: prompt && prompt !== codeDefault ? prompt : null,
    enabled: enabled ?? true,
  };

  // Diff against the stored row, or against the implicit defaults when none
  // exists (null overrides + enabled) — the read-time merge treats both alike.
  const existing = await aiFeaturePromptsService.get(feature, task);
  const changedFields: string[] = [];
  if ((existing?.provider ?? null) !== row.provider) changedFields.push("provider");
  if ((existing?.model ?? null) !== row.model) changedFields.push("model");
  if ((existing?.system_prompt ?? null) !== row.system_prompt) changedFields.push("system_prompt");
  if ((existing?.enabled ?? true) !== row.enabled) changedFields.push("enabled");
  if (changedFields.length === 0) return ok({ feature, task, changedFields });

  await aiFeaturePromptsService.upsert(row);
  await bus.emit("ai.feature_prompts_updated", { feature, task, changedFields }, { actorUserId });
  return ok({ feature, task, changedFields });
});
