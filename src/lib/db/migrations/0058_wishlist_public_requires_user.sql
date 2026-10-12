-- 0058 — DB-enforce the invariant the app already guarantees: only a signed-in
-- user's wishlist can be public (a guest token list has no owner to attribute).
-- Defense-in-depth behind the single app writer (setPublicProfile). Idempotent.
-- Existing rows are all is_public=false, so the constraint validates instantly.
DO $$ BEGIN
  ALTER TABLE "wishlists" ADD CONSTRAINT "wishlists_public_requires_user"
    CHECK (NOT "is_public" OR "user_id" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
