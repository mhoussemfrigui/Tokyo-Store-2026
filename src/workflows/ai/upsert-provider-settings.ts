import "server-only";

import { z } from "zod";

import { aiProviderSettingsService } from "@/modules/ai";
import type { NewAiProviderSettingsRow } from "@/modules/ai/schema";
import { encryptSecret } from "@/lib/crypto/secrets";
import { invalidateAiConfigCache } from "@/lib/ai/config";
import { AI_PROVIDER_IDS, getAiProvider } from "@/lib/ai/providers";
import {
  aiBaseUrlChangeRefusal,
  normalizeAiBaseUrl,
  validateAiBaseUrl,
} from "@/lib/ai/validate-base-url";
import { resolveUserPermissions } from "@/lib/rbac/authorize";
import { WILDCARD } from "@/lib/rbac/registry";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Persist an AI provider's settings: the API key (encrypted), optional custom
 * base URL, optional default model, and the on/off `enabled` flag.
 *
 * The key arrives as PLAINTEXT; it's encrypted here. An empty / omitted key
 * KEEPS the existing ciphertext (so editing the base URL or toggling enabled
 * doesn't wipe a stored key, and a blank "•••" field is a no-op). Unlike
 * payments, the `enabled` flag lives in this row (no storefront read).
 *
 * The AI page saves all providers at once: when a provider's stored row already
 * matches the submission (no key typed, same base URL / model / enabled) nothing
 * is written or emitted, so one save no longer logs a warn audit row per
 * provider. With NO row yet the upsert still runs (a first row pins the explicit
 * `enabled` flag), but `ai.provider_settings_updated` is emitted ONLY when a
 * field actually changed — `enabled` is diffed against the EFFECTIVE previous
 * state (an env-only key with no row resolves as enabled, so unticking it is a
 * real, audited change).
 *
 * The base URL is stored without trailing slashes, and moving it is OWNER-gated
 * (`aiBaseUrlChangeRefusal`): the resolver pairs the configured key — env var or
 * encrypted DB value — with this host, so a delegated `system_ai:update`
 * operator could otherwise point an env-keyed (or someone else's stored-key)
 * provider at their own server and collect the key on the next AI call.
 */

const schema = z.object({
  provider: z.enum(AI_PROVIDER_IDS),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  defaultModel: z.string().optional(),
  enabled: z.boolean().optional(),
});

export const upsertAiProviderSettingsWorkflow = workflow<
  [z.input<typeof schema>, { actorUserId: string }],
  { provider: string; changedFields: string[] }
>("ai.upsert_provider_settings", async (input, { actorUserId }) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const { provider, apiKey, baseUrl, defaultModel, enabled } = parsed.data;

  // The base URL is fetched server-side with the API key in a header — block
  // SSRF / key-exfil to link-local + cloud-metadata hosts before storing it.
  // Trailing slashes are stripped (the client appends `/chat/completions`, …).
  const trimmedBaseUrl = normalizeAiBaseUrl(baseUrl);
  if (trimmedBaseUrl) {
    const urlError = validateAiBaseUrl(trimmedBaseUrl);
    if (urlError) return fail("validation", urlError);
  }

  const existing = await aiProviderSettingsService.get(provider);
  const def = getAiProvider(provider);
  const envKey = Boolean(def && (process.env[def.apiKeyEnv] ?? "").trim());
  const newKeySubmitted = typeof apiKey === "string" && apiKey.trim().length > 0;

  // Where the key would be SENT. Unchanged effective endpoint (e.g. the form
  // echoing the resolved default, or a legacy trailing slash) keeps the stored
  // value as-is — no churn, no audit row, nothing for the owner gate to judge.
  const providerDefault = normalizeAiBaseUrl(def?.defaultBaseUrl);
  const previousEndpoint = normalizeAiBaseUrl(existing?.base_url) || providerDefault;
  const nextEndpoint = trimmedBaseUrl || providerDefault;
  const endpointChanged = nextEndpoint !== previousEndpoint;
  if (endpointChanged) {
    const refusal = aiBaseUrlChangeRefusal({
      isOwner: (await resolveUserPermissions(actorUserId)).has(WILDCARD),
      keySource: envKey ? "env" : existing?.api_key_enc ? "admin" : "none",
      newKeySubmitted,
      previous: previousEndpoint,
      next: nextEndpoint,
      providerDefault,
    });
    if (refusal) return fail("forbidden", refusal);
  }

  const row: NewAiProviderSettingsRow = {
    provider,
    // Carry forward existing ciphertext so a partial edit never wipes the key.
    api_key_enc: existing?.api_key_enc ?? null,
    base_url: endpointChanged ? trimmedBaseUrl || null : (existing?.base_url ?? null),
    default_model: defaultModel?.trim() ? defaultModel.trim() : null,
    enabled: enabled ?? existing?.enabled ?? false,
  };

  const changedFields: string[] = [];
  if (newKeySubmitted) changedFields.push("api_key");
  if ((existing?.base_url ?? null) !== row.base_url) changedFields.push("base_url");
  if ((existing?.default_model ?? null) !== row.default_model) changedFields.push("default_model");
  // Effective previous state: with no row an env-only key resolves as enabled
  // (lib/ai/config.ts), so that is the baseline the toggle is compared against.
  if ((existing?.enabled ?? envKey) !== row.enabled) changedFields.push("enabled");
  // Stored row already matches → no write, no audit row.
  if (existing && changedFields.length === 0) return ok({ provider, changedFields });

  if (newKeySubmitted) {
    // encryptSecret throws if PAYMENT_ENCRYPTION_KEY is unset — the caller
    // guards on that and surfaces a friendly message.
    row.api_key_enc = encryptSecret(apiKey.trim());
  }

  await aiProviderSettingsService.upsert(row);
  invalidateAiConfigCache(provider);

  // Audited (warn) — rotating an AI key / changing base_url / toggling enabled is a
  // security-sensitive credential change, mirroring payment.provider_settings_updated
  // (the base_url is the SSRF/key-exfil vector, validated above). A first row
  // written with nothing effectively changed stays silent.
  if (changedFields.length > 0) {
    await bus.emit("ai.provider_settings_updated", { provider, changedFields }, { actorUserId });
  }
  return ok({ provider, changedFields });
});
