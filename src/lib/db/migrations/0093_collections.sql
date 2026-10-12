-- Product Collections: a first-class merchandising entity ("Collection d'Été")
-- the operator creates + assigns products to, with its own SEO-friendly,
-- médiathèque-imaged public page at /collection/<slug>. Mirrors the BRAND +
-- CATEGORY patterns. Idempotent.
--
-- `collections` owns its table; products attach via the `product_collections`
-- join (no direct FK on products). `image_media_id` / `og_image_media_id` are
-- soft links to media rows. The slug is unique among LIVE (non-deleted)
-- collections — a soft-deleted row frees its slug for reuse (partial index).
CREATE TABLE IF NOT EXISTS "collections" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "image_media_id" text,
  "meta_title" text,
  "meta_description" text,
  "canonical_url" text,
  "noindex" boolean DEFAULT false NOT NULL,
  "og_image_media_id" text,
  "display_order" integer DEFAULT 0 NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint
-- Partial: uniqueness among LIVE collections only, so a soft-deleted (archived)
-- collection frees its slug (mirrors brands_slug_unique).
CREATE UNIQUE INDEX IF NOT EXISTS "collections_slug_unique" ON "collections" ("slug") WHERE "deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collections_display_order_idx" ON "collections" ("display_order");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collections_og_image_media_id_idx" ON "collections" ("og_image_media_id") WHERE "og_image_media_id" is not null;--> statement-breakpoint
-- product ↔ collection join. FKs ON DELETE CASCADE on BOTH sides so deleting a
-- product OR a collection never orphans a row.
CREATE TABLE IF NOT EXISTS "product_collections" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "product_id" uuid NOT NULL,
  "collection_id" uuid NOT NULL,
  "display_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- NB: index prefix is "pcol_", NOT "pc_". The "pc_" namespace already belongs to
-- product_categories (pc_pair_unique / pc_product_idx) and "pcomp_" to
-- product_complementary. Postgres index names are schema-global, so a "pc_*"
-- name here would collide and silently no-op under CREATE INDEX IF NOT EXISTS,
-- leaving the index uncreated on every database.
CREATE UNIQUE INDEX IF NOT EXISTS "pcol_pair_unique" ON "product_collections" ("collection_id","product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pcol_collection_idx" ON "product_collections" ("collection_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pcol_product_idx" ON "product_collections" ("product_id");--> statement-breakpoint
ALTER TABLE "product_collections" DROP CONSTRAINT IF EXISTS "product_collections_product_id_fkey";--> statement-breakpoint
ALTER TABLE "product_collections" ADD CONSTRAINT "product_collections_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "product_collections" DROP CONSTRAINT IF EXISTS "product_collections_collection_id_fkey";--> statement-breakpoint
ALTER TABLE "product_collections" ADD CONSTRAINT "product_collections_collection_id_fkey"
  FOREIGN KEY ("collection_id") REFERENCES "collections"("id") ON DELETE CASCADE;
