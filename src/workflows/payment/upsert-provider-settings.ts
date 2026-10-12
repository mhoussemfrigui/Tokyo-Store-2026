import "server-only";

import { z } from "zod";

import { paymentSettingsService } from "@/modules/payment";
import type { NewPaymentProviderSettingsRow } from "@/modules/payment/schema";
import { encryptSecret } from "@/lib/crypto/secrets";
import { invalidatePaymentConfigCache } from "@/lib/payments/config";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Persist a payment provider's credentials (encrypted) + test_mode.
 *
 * Secrets arrive as PLAINTEXT keyed by field; they're encrypted here. An empty
 * / omitted secret KEEPS the existing ciphertext (so editing one field doesn't
 * wipe the others, and a blank "•••" field is a no-op). The on/off `enabled`
 * flag is NOT handled here — it lives in site_settings and is written by the
 * action alongside this call.
 *
 * Diffed against the stored row: `changedFields` lists test_mode only when it
 * really changes and a credential only when a new value was typed, and a save
 * that changes nothing (e.g. only the COD label was edited on the page) writes
 * no row and emits nothing — so the warn « identifiants mis à jour » audit row
 * marks a REAL credential swap / sandbox flip instead of every routine save.
 */

const FIELD_TO_COLUMN: Record<string, Record<string, keyof NewPaymentProviderSettingsRow>> = {
  clictopay: { username: "username_enc", password: "password_enc" },
  flouci: { app_token: "app_token_enc", app_secret: "app_secret_enc" },
};

const schema = z.object({
  provider: z.enum(["clictopay", "flouci"]),
  testMode: z.boolean().optional(),
  secrets: z.record(z.string(), z.string()).optional(),
});

export const upsertPaymentProviderSettingsWorkflow = workflow<
  [z.input<typeof schema>, { actorUserId: string }],
  { provider: string; changedFields: string[] }
>("payment.upsert_provider_settings", async (input, { actorUserId }) => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("validation", "Validation échouée");
  const { provider, testMode, secrets } = parsed.data;
  const fieldMap = FIELD_TO_COLUMN[provider];

  const existing = await paymentSettingsService.get(provider);

  // changedFields: test_mode only when it differs from the stored value (no row
  // = the resolver's default, sandbox ON), plus each credential field that
  // received a fresh value this save — empty/blank secrets keep the stored one.
  const changedFields = [
    ...(testMode !== undefined && testMode !== (existing?.test_mode ?? true) ? ["test_mode"] : []),
    ...Object.keys(fieldMap).filter((field) => {
      const val = secrets?.[field];
      return typeof val === "string" && val.trim().length > 0;
    }),
  ];
  // Nothing changes → no write, no audit row (a missing row resolves exactly
  // like the defaults this upsert would create).
  if (changedFields.length === 0) return ok({ provider, changedFields });

  // Carry forward existing ciphertext so a partial edit never wipes a field.
  const row: NewPaymentProviderSettingsRow = {
    provider,
    test_mode: testMode ?? existing?.test_mode ?? true,
    api_key_enc: existing?.api_key_enc ?? null,
    wallet_id_enc: existing?.wallet_id_enc ?? null,
    username_enc: existing?.username_enc ?? null,
    password_enc: existing?.password_enc ?? null,
    app_token_enc: existing?.app_token_enc ?? null,
    app_secret_enc: existing?.app_secret_enc ?? null,
  };

  if (secrets) {
    for (const [field, col] of Object.entries(fieldMap)) {
      const val = secrets[field];
      if (typeof val === "string" && val.trim().length > 0) {
        // encryptSecret throws if PAYMENT_ENCRYPTION_KEY is unset — the caller
        // guards on that and surfaces a friendly message.
        (row[col] as string) = encryptSecret(val.trim());
      }
    }
  }

  await paymentSettingsService.upsert(row);
  invalidatePaymentConfigCache(provider);

  await bus.emit(
    "payment.provider_settings_updated",
    { provider, changedFields },
    { actorUserId },
  );

  return ok({ provider, changedFields });
});
