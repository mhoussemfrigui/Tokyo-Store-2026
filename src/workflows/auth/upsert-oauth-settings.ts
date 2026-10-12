import "server-only";

import { z } from "zod";

import { oauthSettingsService, type NewOAuthProviderSettingsRow } from "@/modules/oauth";
import { encryptSecret } from "@/lib/crypto/secrets";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Social-login (OAuth) client credentials — the admin-saved, encrypted
 * `oauth_provider_settings` row of Google / Facebook (Clients → Connexion &
 * comptes). Mirrors workflows/payment/upsert-provider-settings.ts: the write
 * goes through here so every credential swap or erase leaves a warn-level
 * `auth.oauth_settings_updated` audit row WITH the acting admin (the table has
 * no actor column). The payload carries the NAMES of the changed fields only —
 * never a client id / secret, plaintext or ciphertext.
 *
 * The env-lock (a set GOOGLE_* / FACEBOOK_* var force-overrides) and the
 * « PAYMENT_ENCRYPTION_KEY configured » guard stay in the action, which also
 * rebuilds the cached auth instance afterwards.
 */

const providerSchema = z.enum(["google", "facebook"]);

const upsertSchema = z.object({
  provider: providerSchema,
  clientId: z.string().trim().max(1024).optional(),
  clientSecret: z.string().trim().max(1024).optional(),
});

/**
 * Save the typed credentials of one provider (encrypted). Write-only: an empty /
 * omitted field KEEPS the stored value, so `changedFields` lists exactly the
 * fields that received a fresh value — and a save with neither writes no row and
 * emits nothing.
 */
export const upsertOAuthSettingsWorkflow = workflow<
  [z.input<typeof upsertSchema>, { actorUserId: string }],
  { provider: string; changedFields: string[] }
>("auth.upsert_oauth_settings", async (input, { actorUserId }) => {
  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Identifiants OAuth invalides.");
  const { provider, clientId, clientSecret } = parsed.data;

  const changedFields = [...(clientId ? ["client_id"] : []), ...(clientSecret ? ["client_secret"] : [])];
  if (changedFields.length === 0) return ok({ provider, changedFields });

  // Only the typed columns are written — upsert() leaves the others untouched.
  // encryptSecret throws if PAYMENT_ENCRYPTION_KEY is unset — the caller guards.
  const patch: NewOAuthProviderSettingsRow = { provider };
  if (clientId) patch.client_id_enc = encryptSecret(clientId);
  if (clientSecret) patch.client_secret_enc = encryptSecret(clientSecret);
  await oauthSettingsService.upsert(patch);

  await bus.emit("auth.oauth_settings_updated", { provider, changedFields }, { actorUserId });

  return ok({ provider, changedFields });
});

/**
 * « Supprimer les identifiants » — erase the stored client id + secret of one
 * provider. Audited as `changedFields: ["cleared"]`; erasing a provider with
 * nothing stored is a no-op (no write, no event).
 */
export const clearOAuthSettingsWorkflow = workflow<
  [{ provider: string }, { actorUserId: string }],
  { provider: string; cleared: boolean }
>("auth.clear_oauth_settings", async (input, { actorUserId }) => {
  const parsed = providerSchema.safeParse(input.provider);
  if (!parsed.success) return fail("validation", "Fournisseur inconnu.");
  const provider = parsed.data;

  const existing = await oauthSettingsService.get(provider);
  if (!existing?.client_id_enc && !existing?.client_secret_enc) {
    return ok({ provider, cleared: false });
  }

  await oauthSettingsService.upsert({ provider, client_id_enc: null, client_secret_enc: null });

  await bus.emit("auth.oauth_settings_updated", { provider, changedFields: ["cleared"] }, { actorUserId });

  return ok({ provider, cleared: true });
});
