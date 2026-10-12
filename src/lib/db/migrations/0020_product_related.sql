-- Configurable "Vous aimerez aussi" (related products): a per-product mode +
-- a curated product↔product list (used by the manual/ai modes). Idempotent.
--
-- 1) related_mode on products — how the rail is populated. Default 'auto' keeps
--    the existing derived behaviour for every untouched product.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "related_mode" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_related_mode_chk";--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_related_mode_chk"
  CHECK ("related_mode" IN ('auto','same_subcategory','same_brand','mixed','ai','manual'));--> statement-breakpoint
-- 2) Curated cross-sell list. FKs ON DELETE CASCADE on BOTH sides so deleting
--    either the owner or a referenced product never orphans a row.
CREATE TABLE IF NOT EXISTS "product_related" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "product_id" uuid NOT NULL,
  "related_product_id" uuid NOT NULL,
  "display_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pr_pair_unique" ON "product_related" ("product_id","related_product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_product_idx" ON "product_related" ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pr_related_idx" ON "product_related" ("related_product_id");--> statement-breakpoint
ALTER TABLE "product_related" DROP CONSTRAINT IF EXISTS "product_related_product_id_fkey";--> statement-breakpoint
ALTER TABLE "product_related" ADD CONSTRAINT "product_related_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "product_related" DROP CONSTRAINT IF EXISTS "product_related_related_product_id_fkey";--> statement-breakpoint
ALTER TABLE "product_related" ADD CONSTRAINT "product_related_related_product_id_fkey"
  FOREIGN KEY ("related_product_id") REFERENCES "products"("id") ON DELETE CASCADE;
