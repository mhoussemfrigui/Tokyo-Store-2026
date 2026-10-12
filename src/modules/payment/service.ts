import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  payment_provider_settings,
  type NewPaymentProviderSettingsRow,
  type PaymentProviderSettingsRow,
} from "./schema";

/**
 * CRUD on `payment_provider_settings`. Stores/returns ciphertext as-is —
 * encryption/decryption is the caller's job (`src/lib/crypto/secrets.ts` +
 * the resolver in `src/lib/payments/config.ts`). No business logic here.
 */
class PaymentSettingsService {
  async get(provider: string): Promise<PaymentProviderSettingsRow | null> {
    const [row] = await db
      .select()
      .from(payment_provider_settings)
      .where(eq(payment_provider_settings.provider, provider))
      .limit(1);
    return row ?? null;
  }

  async listAll(): Promise<PaymentProviderSettingsRow[]> {
    return db.select().from(payment_provider_settings);
  }

  /** Upsert a provider row. Only the columns present in `input` are written. */
  async upsert(input: NewPaymentProviderSettingsRow): Promise<PaymentProviderSettingsRow> {
    const [row] = await db
      .insert(payment_provider_settings)
      .values(input)
      .onConflictDoUpdate({
        target: payment_provider_settings.provider,
        set: { ...input, updated_at: sql`now()` },
      })
      .returning();
    return row;
  }
}

export const paymentSettingsService = new PaymentSettingsService();
