-- 0184 — Editorial AUTHOR profiles (« Auteurs »). Add-only, idempotent, non-breaking.
--
-- A staff-curated schema.org Person that blog posts reference for authorship: a
-- durable @id for JSON-LD `author`, storefront bylines, and a public author
-- archive at /auteur/<slug>. DISTINCT from the pre-existing `author_user_id`
-- soft-link (whoever SAVED the row) — that column stays; this is the
-- admin-chosen editorial profile with bio / avatar / job title / sameAs. When a
-- post has an editorial author it drives the byline + Person schema; otherwise
-- the storefront falls back to today's behaviour (author_user_id name, else
-- Organization).
CREATE TABLE IF NOT EXISTS "authors" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "slug" text NOT NULL,
  "name" text NOT NULL,
  "bio" text,
  "job_title" text,
  "expertise" text,
  "avatar_media_id" text,
  "same_as" text,
  "meta_title" text,
  "meta_description" text,
  "canonical_url" text,
  "noindex" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);--> statement-breakpoint
-- Slug unique across soft-deleted rows too (a retired author keeps reserving its slug).
CREATE UNIQUE INDEX IF NOT EXISTS "authors_slug_unique" ON "authors" ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "authors_active_idx" ON "authors" ("is_active");--> statement-breakpoint
-- The editorial-author FK on blog_posts (soft-link author_user_id is unchanged).
ALTER TABLE "blog_posts" ADD COLUMN IF NOT EXISTS "author_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blog_posts_author_fk') THEN
    ALTER TABLE "blog_posts"
      ADD CONSTRAINT "blog_posts_author_fk"
      FOREIGN KEY ("author_id") REFERENCES "authors"("id") ON DELETE SET NULL;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blog_posts_author_id_idx" ON "blog_posts" ("author_id");
