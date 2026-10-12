-- 0212 — « Cités dans l'article » : link blog posts to catalogue products.
--
-- An ORDERED N-N join powering the article's "Cités dans l'article" rail + inline
-- product cards. post_id has a real FK → blog_posts(id) ON DELETE CASCADE (a post
-- delete drops its links); product_id is a SOFT link to products.id (cross-module
-- rule — no FK; the storefront enrich resolves it to a live product card and drops
-- unpublished/missing ids). display_order keeps the operator's chosen order.
-- Idempotent: IF NOT EXISTS guards.

CREATE TABLE IF NOT EXISTS "blog_post_products" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "post_id" uuid NOT NULL,
  "product_id" uuid NOT NULL,
  "display_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "blog_post_products"
    ADD CONSTRAINT "blog_post_products_post_id_fk"
    FOREIGN KEY ("post_id") REFERENCES "blog_posts"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "blog_post_products_pair_unique" ON "blog_post_products" ("post_id","product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blog_post_products_post_idx" ON "blog_post_products" ("post_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blog_post_products_product_idx" ON "blog_post_products" ("product_id");
