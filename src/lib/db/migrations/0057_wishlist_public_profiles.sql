-- 0057 — Public shareable favorites (opt-in, off by default). Idempotent.
-- A user's wishlist can be made public at /u/<slug>. Guest (token) lists can't
-- be public (no user_id). The global feature flag lives in site_settings
-- (`social.favorites_public_enabled`, default false) — no column here.
ALTER TABLE "wishlists" ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "wishlists" ADD COLUMN IF NOT EXISTS "public_slug" text;--> statement-breakpoint
ALTER TABLE "wishlists" ADD COLUMN IF NOT EXISTS "public_display_name" text;--> statement-breakpoint
-- Case-insensitive vanity-handle uniqueness (functional partial index — NULLs
-- allowed for the un-shared majority).
CREATE UNIQUE INDEX IF NOT EXISTS "wishlists_public_slug_uniq" ON "wishlists" (lower("public_slug")) WHERE "public_slug" IS NOT NULL;
