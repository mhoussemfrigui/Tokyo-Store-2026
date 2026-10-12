import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Social-login (OAuth) provider settings — admin-configurable credentials.
 *
 * One row per provider (`google` | `facebook`). Both columns hold
 * AES-256-GCM ciphertext (never plaintext at rest — see
 * `src/lib/crypto/secrets.ts`); the client_id is not strictly secret, but it
 * is stored encrypted for uniformity with the secret and so neither value is
 * ever round-tripped to the browser.
 *
 * The on/off button-visibility flag is NOT here: it lives in `site_settings`
 * under `auth.social.<provider>_enabled` (the storefront reads those keys),
 * edited from the same admin page (Clients → Connexion & comptes).
 *
 * Precedence at read time (`src/lib/auth/social-config.ts`): a matching ENV
 * var (`GOOGLE_*` / `FACEBOOK_*`), when set, FORCE-OVERRIDES this row;
 * otherwise the decrypted DB value is used. Mirrors `payment_provider_settings`.
 */
export const oauth_provider_settings = pgTable("oauth_provider_settings", {
  provider: text("provider").primaryKey(),

  client_id_enc: text("client_id_enc"),
  client_secret_enc: text("client_secret_enc"),

  updated_at: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type OAuthProviderSettingsRow = typeof oauth_provider_settings.$inferSelect;
export type NewOAuthProviderSettingsRow = typeof oauth_provider_settings.$inferInsert;
