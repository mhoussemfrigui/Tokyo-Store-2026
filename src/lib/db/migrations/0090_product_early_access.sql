-- Fidelity early-access gating. Each loyalty level gets a "Délai" (days) a newly
-- published product stays hidden from that level; higher tiers (delay 0) see new
-- products first, lower tiers progressively. A per-product opt-out exempts a
-- product (visible to everyone at publish). Effective visible-from for a level =
-- products.published_at + (level.early_access_delay_days * INTERVAL '1 day').
ALTER TABLE "coin_levels" ADD COLUMN IF NOT EXISTS "early_access_delay_days" integer;--> statement-breakpoint
ALTER TABLE "coin_levels" DROP CONSTRAINT IF EXISTS "coin_levels_early_access_delay_check";--> statement-breakpoint
ALTER TABLE "coin_levels" ADD CONSTRAINT "coin_levels_early_access_delay_check" CHECK ("early_access_delay_days" IS NULL OR "early_access_delay_days" >= 0);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "early_access_enabled" boolean NOT NULL DEFAULT true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_early_access_idx" ON "products" ("published_at") WHERE "early_access_enabled" = true AND "deleted_at" IS NULL;
