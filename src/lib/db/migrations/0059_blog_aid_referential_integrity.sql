-- 0059 — Blog & Aide referential integrity.
--
-- These two CMS modules shipped with in-module links that had NO foreign key,
-- so deleting a category left dangling category_id on its posts/articles, and
-- aid_article_steps linked to its parent via an UNTYPED text column with no FK
-- (orphan steps could survive a parent hard-delete). This migration closes the
-- gaps. Backfills run FIRST so each constraint validates on existing data.
-- Idempotent + safe to re-run.

-- ── 1. category_id → SET NULL FKs ───────────────────────────────────────────
-- Null out any orphaned link first (so ADD CONSTRAINT validates), then add the
-- FK so a future category delete cleanly unsets it instead of orphaning rows.
UPDATE "blog_posts" SET "category_id" = NULL
  WHERE "category_id" IS NOT NULL
    AND "category_id" NOT IN (SELECT "id" FROM "blog_categories");
UPDATE "aid_articles" SET "category_id" = NULL
  WHERE "category_id" IS NOT NULL
    AND "category_id" NOT IN (SELECT "id" FROM "aid_categories");

DO $$ BEGIN
  ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "blog_categories"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "aid_articles" ADD CONSTRAINT "aid_articles_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "aid_categories"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. aid_article_steps.article_id: text → uuid + CASCADE FK ───────────────
-- Drop orphan steps (parent gone), then narrow the type to match the uuid
-- parent and add the cascade FK so steps die with their article. The orphan
-- DELETE is guarded on the column still being text so a MANUAL re-run (after
-- the type already flipped to uuid) doesn't hit `uuid NOT IN (text)` — and the
-- CASCADE FK already keeps orphans out on every subsequent run anyway.
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
        WHERE table_name = 'aid_article_steps' AND column_name = 'article_id') = 'text' THEN
    DELETE FROM "aid_article_steps"
      WHERE "article_id" NOT IN (SELECT "id"::text FROM "aid_articles");
    ALTER TABLE "aid_article_steps" ALTER COLUMN "article_id" TYPE uuid USING "article_id"::uuid;
  END IF;
END $$;

DO $$ BEGIN
  ALTER TABLE "aid_article_steps" ADD CONSTRAINT "aid_article_steps_article_id_fkey"
    FOREIGN KEY ("article_id") REFERENCES "aid_articles"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. published ⇒ published_at-not-null invariant ──────────────────────────
-- The workflows already stamp published_at on publish; this enforces it so a
-- published row can never have a null date (the storefront orders by it).
UPDATE "blog_posts"  SET "published_at" = COALESCE("published_at", "created_at")
  WHERE "is_published" AND "published_at" IS NULL;
UPDATE "aid_articles" SET "published_at" = COALESCE("published_at", "created_at")
  WHERE "is_published" AND "published_at" IS NULL;

DO $$ BEGIN
  ALTER TABLE "blog_posts" ADD CONSTRAINT "blog_posts_published_at_chk"
    CHECK (NOT "is_published" OR "published_at" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "aid_articles" ADD CONSTRAINT "aid_articles_published_at_chk"
    CHECK (NOT "is_published" OR "published_at" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
