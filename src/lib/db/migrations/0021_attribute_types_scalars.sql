-- Attributs overhaul: richer kinds (color/boolean/number/text), a per-value
-- colour hex, and a per-(product,attribute) scalar table for the number/text
-- kinds (which don't fit the predefined value-list M2M). Idempotent.
--
-- 1) Extend the attribute_kind enum. ADD VALUE IF NOT EXISTS is idempotent and
--    PG16-safe inside the migrator txn (values are added, not used, here).
ALTER TYPE "attribute_kind" ADD VALUE IF NOT EXISTS 'color';--> statement-breakpoint
ALTER TYPE "attribute_kind" ADD VALUE IF NOT EXISTS 'boolean';--> statement-breakpoint
ALTER TYPE "attribute_kind" ADD VALUE IF NOT EXISTS 'number';--> statement-breakpoint
ALTER TYPE "attribute_kind" ADD VALUE IF NOT EXISTS 'text';--> statement-breakpoint
-- 2) Per-value colour hex (kind="color"); null for every other kind.
ALTER TABLE "product_attribute_values" ADD COLUMN IF NOT EXISTS "color_hex" text;--> statement-breakpoint
-- 3) Per-(product, attribute) scalar storage for number/text kinds.
CREATE TABLE IF NOT EXISTS "product_attribute_scalars" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "product_id" uuid NOT NULL,
  "attribute_id" uuid NOT NULL,
  "numeric_value" numeric,
  "text_value" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_attribute_scalars_product_attr_unique"
  ON "product_attribute_scalars" ("product_id","attribute_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_attribute_scalars_attribute_idx"
  ON "product_attribute_scalars" ("attribute_id");--> statement-breakpoint
ALTER TABLE "product_attribute_scalars" DROP CONSTRAINT IF EXISTS "product_attribute_scalars_product_id_fkey";--> statement-breakpoint
ALTER TABLE "product_attribute_scalars" ADD CONSTRAINT "product_attribute_scalars_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "product_attribute_scalars" DROP CONSTRAINT IF EXISTS "product_attribute_scalars_attribute_id_fkey";--> statement-breakpoint
ALTER TABLE "product_attribute_scalars" ADD CONSTRAINT "product_attribute_scalars_attribute_id_fkey"
  FOREIGN KEY ("attribute_id") REFERENCES "product_attributes"("id") ON DELETE CASCADE;
