-- 0186 — Per-category SEO overrides for blog categories. Add-only, idempotent.
-- meta_title / meta_description feed the SHARED buildPageMetadata (empty → the
-- category name / description); noindex force-excludes the /blog/category/<slug>
-- page from search + the sitemap (on top of the existing empty/inactive gates).
ALTER TABLE "blog_categories" ADD COLUMN IF NOT EXISTS "meta_title" text;--> statement-breakpoint
ALTER TABLE "blog_categories" ADD COLUMN IF NOT EXISTS "meta_description" text;--> statement-breakpoint
ALTER TABLE "blog_categories" ADD COLUMN IF NOT EXISTS "noindex" boolean NOT NULL DEFAULT false;
