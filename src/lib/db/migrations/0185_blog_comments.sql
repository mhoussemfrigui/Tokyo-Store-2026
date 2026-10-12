-- 0185 — Reader comments + optional star ratings on blog posts. Add-only, idempotent.
--
-- ACCOUNT-ONLY (user_id required). `status` gates visibility (pending → approved →
-- rejected); only approved rows render + feed the post AggregateRating. `rating` is
-- NULLable (1..5). FK → blog_posts ON DELETE CASCADE (a deleted post drops its
-- comments). A partial UNIQUE (user_id, post_id) WHERE deleted_at IS NULL gives one
-- live comment per reader per post (resubmit updates it) → one rating per reader.
CREATE TABLE IF NOT EXISTS "blog_comments" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "post_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "author_name" text NOT NULL,
  "body" text NOT NULL,
  "rating" integer,
  "status" text NOT NULL DEFAULT 'pending',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "blog_comments_rating_check" CHECK ("rating" IS NULL OR ("rating" BETWEEN 1 AND 5)),
  CONSTRAINT "blog_comments_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected'))
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'blog_comments_post_fk') THEN
    ALTER TABLE "blog_comments"
      ADD CONSTRAINT "blog_comments_post_fk"
      FOREIGN KEY ("post_id") REFERENCES "blog_posts"("id") ON DELETE CASCADE;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blog_comments_post_status_created_idx" ON "blog_comments" ("post_id", "status", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blog_comments_status_created_idx" ON "blog_comments" ("status", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blog_comments_user_idx" ON "blog_comments" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "blog_comments_user_post_unique" ON "blog_comments" ("user_id", "post_id") WHERE "deleted_at" IS NULL;
