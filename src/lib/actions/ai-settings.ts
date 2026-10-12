"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { isEncryptionConfigured } from "@/lib/crypto/secrets";
import { invalidateAiConfigCache } from "@/lib/ai/config";
import { EMBEDDING_CAPABLE_PROVIDERS } from "@/lib/ai/embed";
import { AI_PROVIDERS, type AiProvider } from "@/lib/ai/providers";
import { getAiFeature } from "@/lib/ai/tasks";
import { type ActionState } from "@/lib/actions/types";

/**
 * Save the AI & Automation hub: per-provider API key (encrypted), optional
 * custom base URL + default model, and the on/off `enabled` flag.
 *
 * Env-locked fields are skipped (a set `*_API_KEY` env var force-overrides the
 * stored key anyway, and its disabled input submits nothing). The encryption
 * guard mirrors payments: before storing any key we require
 * PAYMENT_ENCRYPTION_KEY (reused — no new encryption key/env).
 */

const envSet = (name: string): boolean => Boolean((process.env[name] ?? "").trim());

export async function saveAiProviderSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_ai", "update");
  const errors: string[] = [];

  for (const p of AI_PROVIDERS) {
    // Read the typed key only when NOT env-locked (env wins; the input is
    // disabled and submits nothing in that case).
    let apiKey: string | undefined;
    if (!envSet(p.apiKeyEnv)) {
      const v = String(formData.get(`secret.${p.id}.api_key`) ?? "").trim();
      if (v) apiKey = v;
    }

    if (apiKey && !isEncryptionConfigured()) {
      return {
        ok: false,
        error: "no_encryption_key",
        message:
          "Définissez PAYMENT_ENCRYPTION_KEY (ex. `openssl rand -base64 32`) avant d'enregistrer des clés API.",
      };
    }

    const baseUrl = String(formData.get(`ai.${p.id}.base_url`) ?? "").trim();
    const defaultModel = String(formData.get(`ai.${p.id}.default_model`) ?? "").trim();
    const enabled = formData.get(`ai.${p.id}.enabled`) === "on";

    const res = await workflows.ai.upsertProviderSettings(
      { provider: p.id, apiKey, baseUrl, defaultModel, enabled },
      { actorUserId: session.user.id },
    );
    if (!res.ok) errors.push(`${p.label}: ${res.message}`);
  }

  invalidateAiConfigCache();
  revalidatePath("/admin/system/ai");

  if (errors.length > 0) {
    return { ok: false, error: "partial", message: `Erreurs : ${errors.join(" · ")}` };
  }
  return { ok: true, message: "Réglages IA enregistrés." };
}

/**
 * Save the Embeddings (semantic search) config — its OWN action for its OWN
 * sub-tab, split out of the provider save so a plain provider save can never
 * blank these (and vice-versa). Two NON-secret CMS settings, not provider rows:
 * WHICH embedding-capable provider + model to use (the API key itself rides the
 * same per-provider encrypted secret saved in the Réglages tab).
 *
 * Normalisation (unchanged from the old inline block): a blank/invalid provider
 * normalises to "" = auto-pick the first ready embedding-capable provider; a
 * blank model = "" = the code default (defaultEmbeddingModelFor). Gated on the
 * same system_ai:update as the provider/prompt saves.
 */
export async function saveAiEmbeddingSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_ai", "update");
  const errors: string[] = [];

  const rawEmbProvider = String(formData.get("ai.embedding_provider") ?? "").trim();
  const embProviderRes = await workflows.cms.upsertSetting(
    {
      key: "ai.embedding_provider",
      value: EMBEDDING_CAPABLE_PROVIDERS.has(rawEmbProvider) ? rawEmbProvider : "",
      type: "text" as never,
      groupKey: "ai",
      label: "Fournisseur d'embeddings (recherche sémantique)",
    },
    { actorUserId: session.user.id },
  );
  if (!embProviderRes.ok) errors.push(`Fournisseur d'embeddings : ${embProviderRes.message}`);
  const embModelRes = await workflows.cms.upsertSetting(
    {
      key: "ai.embedding_model",
      value: String(formData.get("ai.embedding_model") ?? "").trim(),
      type: "text" as never,
      groupKey: "ai",
      label: "Modèle d'embeddings (recherche sémantique)",
    },
    { actorUserId: session.user.id },
  );
  if (!embModelRes.ok) errors.push(`Modèle d'embeddings : ${embModelRes.message}`);

  revalidatePath("/admin/system/ai");

  if (errors.length > 0) {
    return { ok: false, error: "partial", message: `Erreurs : ${errors.join(" · ")}` };
  }
  return { ok: true, message: "Embeddings enregistrés." };
}

/**
 * Save the AI generation prompts for one feature (e.g. "produits"). One row
 * per task is upserted from the form fields `prompt.<task>`, `provider.<task>`,
 * `model.<task>`, `enabled.<task>`. Bind the feature id in the panel:
 *   saveAiFeaturePromptsAction.bind(null, "produits")
 *
 * Prompts are NON-secret — no encryption guard, no env locking.
 */
export async function saveAiFeaturePromptsAction(
  feature: string,
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_ai", "update");

  const def = getAiFeature(feature);
  if (!def) {
    return { ok: false, error: "unknown_feature", message: "Fonctionnalité IA inconnue." };
  }

  const errors: string[] = [];
  for (const task of def.tasks) {
    const systemPrompt = String(formData.get(`prompt.${task.id}`) ?? "").trim();
    // Cast the runtime-validated value to the workflow's narrow union; zod in
    // the workflow still guards it (rejects any non-provider string).
    const provider = (String(formData.get(`provider.${task.id}`) ?? "").trim()) as
      | AiProvider
      | "";
    const model = String(formData.get(`model.${task.id}`) ?? "").trim();
    const enabled = formData.get(`enabled.${task.id}`) === "on";

    const res = await workflows.ai.upsertFeaturePrompts(
      { feature, task: task.id, provider, model, systemPrompt, enabled },
      { actorUserId: session.user.id },
    );
    if (!res.ok) errors.push(`${task.label}: ${res.message}`);
  }

  revalidatePath("/admin/system/ai");

  if (errors.length > 0) {
    return { ok: false, error: "partial", message: `Erreurs : ${errors.join(" · ")}` };
  }
  return { ok: true, message: "Prompts IA enregistrés." };
}
