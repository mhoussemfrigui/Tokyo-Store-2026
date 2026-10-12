import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Payment provider settings — admin-configurable gateway credentials.
 *
 * One row per provider (`clictopay` | `flouci`). Secret columns
 * hold AES-256-GCM ciphertext (never plaintext at rest — see
 * `src/lib/crypto/secrets.ts`). The on/off `enabled` flag is NOT here: it lives
 * in `site_settings` under `checkout.payment.<provider>_enabled` (the storefront
 * already reads those keys), edited from the same admin page.
 *
 * Precedence at read time (`src/lib/payments/config.ts`): a matching ENV var,
 * when set, FORCE-OVERRIDES this row; otherwise the decrypted DB value is used.
 */
export const payment_provider_settings = pgTable("payment_provider_settings", {
  provider: text("provider").primaryKey(),
  test_mode: boolean("test_mode").notNull().default(true),

  // Legacy Konnect columns — retained so historical rows decode; no longer
  // written or read (Konnect was removed as a supported gateway).
  api_key_enc: text("api_key_enc"),
  wallet_id_enc: text("wallet_id_enc"),
  // ClicToPay (SMT)
  username_enc: text("username_enc"),
  password_enc: text("password_enc"),
  // Flouci
  app_token_enc: text("app_token_enc"),
  app_secret_enc: text("app_secret_enc"),

  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type PaymentProviderSettingsRow = typeof payment_provider_settings.$inferSelect;
export type NewPaymentProviderSettingsRow = typeof payment_provider_settings.$inferInsert;
