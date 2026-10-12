import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  oauth_provider_settings,
  type NewOAuthProviderSettingsRow,
  type OAuthProviderSettingsRow,
} from "./schema";

/**
 * CRUD on `oauth_provider_settings`. Stores/returns ciphertext as-is —
 * encryption/decryption is the caller's job (`src/lib/crypto/secrets.ts` +
 * the resolver in `src/lib/auth/social-config.ts`). No business logic here.
 *
 * Mirrors `PaymentSettingsService` (src/modules/payment/service.ts).
 */
class OAuthSettingsService {
  async get(provider: string): Promise<OAuthProviderSettingsRow | null> {
    const [row] = await db
      .select()
      .from(oauth_provider_settings)
      .where(eq(oauth_provider_settings.provider, provider))
      .limit(1);
    return row ?? null;
  }

  async listAll(): Promise<OAuthProviderSettingsRow[]> {
    return db.select().from(oauth_provider_settings);
  }

  /** Upsert a provider row. Only the columns present in `input` are written. */
  async upsert(input: NewOAuthProviderSettingsRow): Promise<OAuthProviderSettingsRow> {
    const [row] = await db
      .insert(oauth_provider_settings)
      .values(input)
      .onConflictDoUpdate({
        target: oauth_provider_settings.provider,
        set: { ...input, updated_at: sql`now()` },
      })
      .returning();
    return row;
  }
}

export const oauthSettingsService = new OAuthSettingsService();
