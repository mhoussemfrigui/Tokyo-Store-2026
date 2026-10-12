import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  ai_provider_settings,
  type NewAiProviderSettingsRow,
  type AiProviderSettingsRow,
} from "./schema";

/**
 * CRUD on `ai_provider_settings`. Stores/returns ciphertext as-is —
 * encryption/decryption is the caller's job (`src/lib/crypto/secrets.ts` +
 * the resolver in `src/lib/ai/config.ts`). No business logic here.
 */
class AiProviderSettingsService {
  async get(provider: string): Promise<AiProviderSettingsRow | null> {
    const [row] = await db
      .select()
      .from(ai_provider_settings)
      .where(eq(ai_provider_settings.provider, provider))
      .limit(1);
    return row ?? null;
  }

  async listAll(): Promise<AiProviderSettingsRow[]> {
    return db.select().from(ai_provider_settings);
  }

  /** Upsert a provider row. Only the columns present in `input` are written. */
  async upsert(input: NewAiProviderSettingsRow): Promise<AiProviderSettingsRow> {
    const [row] = await db
      .insert(ai_provider_settings)
      .values(input)
      .onConflictDoUpdate({
        target: ai_provider_settings.provider,
        set: { ...input, updated_at: sql`now()` },
      })
      .returning();
    return row;
  }
}

export const aiProviderSettingsService = new AiProviderSettingsService();
