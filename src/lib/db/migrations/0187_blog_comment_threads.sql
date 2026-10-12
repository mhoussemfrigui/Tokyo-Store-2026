-- 0187 — Thread blog comments: self-referential parent_id. Add-only, idempotent.
--
-- parent_id NULL = a TOP-LEVEL comment (carries the optional 1..5 rating);
-- parent_id set = a REPLY (rating always NULL — enforced by the CHECK below — and
-- replies are unlimited). The self-FK ON DELETE CASCADE drops a comment's whole
-- reply subtree when it is hard-deleted. The one-live-comment-per-reader partial
-- UNIQUE is rebuilt to apply only to TOP-LEVEL rows so a reader keeps one rated
-- comment but may reply as many times as they like.
ALTER TABLE "blog_comments" ADD COLUMN IF NOT EXISTS "parent_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blog_comments_parent_fk') THEN
    ALTER TABLE "blog_comments"
      ADD CONSTRAINT "blog_comments_parent_fk"
      FOREIGN KEY ("parent_id") REFERENCES "blog_comments"("id") ON DELETE CASCADE;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blog_comments_reply_no_rating_check') THEN
    ALTER TABLE "blog_comments"
      ADD CONSTRAINT "blog_comments_reply_no_rating_check"
      CHECK ("parent_id" IS NULL OR "rating" IS NULL);
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blog_comments_parent_idx" ON "blog_comments" ("parent_id");--> statement-breakpoint
DROP INDEX IF EXISTS "blog_comments_user_post_unique";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "blog_comments_user_post_unique" ON "blog_comments" ("user_id", "post_id") WHERE "parent_id" IS NULL AND "deleted_at" IS NULL;
