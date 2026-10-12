-- ════════════════════════════════════════════════════════════════════════════
-- 0003 — oauth_provider_settings: admin-configurable social-login credentials
-- ════════════════════════════════════════════════════════════════════════════
--
-- One row per provider (google | facebook). Both columns hold AES-256-GCM
-- ciphertext (never plaintext at rest — src/lib/crypto/secrets.ts). A set
-- GOOGLE_* / FACEBOOK_* env var force-overrides the stored value at read time
-- (src/lib/auth/social-config.ts). Mirrors payment_provider_settings.
--
-- NOTE: drizzle-kit also re-emitted `import_jobs` here because migrations
-- 0001/0002 were hand-authored without meta snapshots, leaving the snapshot
-- stuck at the 0000 baseline. That table already exists on every migrated DB
-- (created in 0001, extended in 0002), so its CREATE is intentionally omitted —
-- the refreshed 0003 meta snapshot now reflects the real schema, so future
-- `db:generate` diffs are clean.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE "oauth_provider_settings" (
	"provider" text PRIMARY KEY NOT NULL,
	"client_id_enc" text,
	"client_secret_enc" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
