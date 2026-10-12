-- Make slug uniqueness ignore soft-deleted (tombstoned) rows so an admin can
-- delete a product / brand / attribute and recreate one with the same slug.
-- The app's slug checks (checkSlugAvailability, findBySlug) already filter
-- `deleted_at IS NULL`, but these indexes were TOTAL and disagreed — a
-- delete-then-recreate-same-slug hit a raw 23505 surfaced as a generic error.
-- Mirrors `categories_root_slug_unique`'s partial-index approach.
-- Idempotent: safe to re-run (IF EXISTS / IF NOT EXISTS).
DROP INDEX IF EXISTS "products_slug_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_slug_unique" ON "products" USING btree ("slug") WHERE "deleted_at" IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "brands_slug_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brands_slug_unique" ON "brands" USING btree ("slug") WHERE "deleted_at" IS NULL;--> statement-breakpoint
-- product_attributes carried BOTH a baseline UNIQUE constraint (…_slug_key)
-- and the drizzle uniqueIndex — drop both, then recreate the index partial.
ALTER TABLE "product_attributes" DROP CONSTRAINT IF EXISTS "product_attributes_slug_key";--> statement-breakpoint
DROP INDEX IF EXISTS "product_attributes_slug_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_attributes_slug_unique" ON "product_attributes" USING btree ("slug") WHERE "deleted_at" IS NULL;
