-- "Accessoires supplémentaires" (complementary products): a SECOND, manual-only
-- product↔product cross-sell list (parallel to product_related but with no
-- derived/AI mode — the section only renders when curated). Idempotent.
--
-- Curated cross-sell list. FKs ON DELETE CASCADE on BOTH sides so deleting
-- either the owner or a referenced product never orphans a row.
CREATE TABLE IF NOT EXISTS "product_complementary" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "product_id" uuid NOT NULL,
  "complementary_product_id" uuid NOT NULL,
  "display_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- NB: index prefix is "pcomp_", NOT "pc_". The "pc_" namespace already belongs to
-- product_categories (pc_pair_unique / pc_product_idx). Postgres index names are
-- schema-global, so a "pc_*" name here would collide and silently no-op under
-- CREATE INDEX IF NOT EXISTS, leaving the index uncreated on every database.
CREATE UNIQUE INDEX IF NOT EXISTS "pcomp_pair_unique" ON "product_complementary" ("product_id","complementary_product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pcomp_product_idx" ON "product_complementary" ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pcomp_complement_idx" ON "product_complementary" ("complementary_product_id");--> statement-breakpoint
ALTER TABLE "product_complementary" DROP CONSTRAINT IF EXISTS "product_complementary_product_id_fkey";--> statement-breakpoint
ALTER TABLE "product_complementary" ADD CONSTRAINT "product_complementary_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "product_complementary" DROP CONSTRAINT IF EXISTS "product_complementary_complementary_product_id_fkey";--> statement-breakpoint
ALTER TABLE "product_complementary" ADD CONSTRAINT "product_complementary_complementary_product_id_fkey"
  FOREIGN KEY ("complementary_product_id") REFERENCES "products"("id") ON DELETE CASCADE;
