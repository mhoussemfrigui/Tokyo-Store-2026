-- Optional opt-in two-factor authentication (Better Auth twoFactor plugin).
--
-- Column/table names match the plugin's drizzle-adapter expectations mapped via
-- the explicit schema in src/lib/auth/server.ts: users.two_factor_enabled +
-- a `two_factors` table holding the (encrypted) TOTP secret + backup codes.
-- secret/backup_codes are AES-encrypted by the plugin with BETTER_AUTH_SECRET —
-- never plaintext at rest, never returned to the client.
--
-- UNIQUE on user_id (not the plugin's default non-unique index) enforces one
-- TOTP secret per user from day one, preventing a duplicate-row / non-
-- deterministic-lookup footgun. FK ON DELETE CASCADE matches sessions/accounts.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "two_factor_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "two_factors" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "secret" text NOT NULL,
  "backup_codes" text NOT NULL,
  "verified" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "two_factors_user_unique" ON "two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "two_factors_secret_idx" ON "two_factors" USING btree ("secret");
