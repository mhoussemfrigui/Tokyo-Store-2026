-- API access keys for the external HTTP API. The plaintext key is shown once
-- and never stored — only its SHA-256 hash. `prefix` is the non-secret leading
-- slice for identification. Idempotent.
CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "name" text NOT NULL,
  "prefix" text NOT NULL,
  "key_hash" text NOT NULL,
  "scopes" text[] NOT NULL DEFAULT '{}',
  "expires_at" timestamptz,
  "last_used_at" timestamptz,
  "revoked_at" timestamptz,
  "created_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hash_unique" ON "api_keys" ("key_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_active_idx" ON "api_keys" ("revoked_at");
