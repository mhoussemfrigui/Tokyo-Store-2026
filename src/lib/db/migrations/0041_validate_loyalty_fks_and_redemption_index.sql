-- 0041 — Catalog hygiene + a hot-path index for the new redemption-detail view.
-- (1) VALIDATE the four constraints 0040 added NOT VALID. On the freshly-created
--     allocation tables there were no pre-existing rows to scan, and the
--     loyalty_mode column was brand-new (uniformly NULL), so validating is free
--     here — it just flips convalidated=true so the planner can fully exploit
--     the FKs. The pre-existing business_members table is tiny + clean.
-- (2) Add (promotion_id, created_at DESC) on promotion_redemptions so the admin
--     "Utilisations" detail (WHERE promotion_id = ? ORDER BY created_at DESC
--     LIMIT 50) is an index top-N instead of a scan+sort on hot promos.
-- All idempotent: VALIDATE is guarded on convalidated; the index uses IF NOT EXISTS.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_profiles_loyalty_mode_chk' AND NOT convalidated) THEN
    ALTER TABLE "customer_profiles" VALIDATE CONSTRAINT "customer_profiles_loyalty_mode_chk";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_level_allocations_business_id_fkey' AND NOT convalidated) THEN
    ALTER TABLE "business_level_allocations" VALIDATE CONSTRAINT "business_level_allocations_business_id_fkey";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_level_allocations_level_id_fkey' AND NOT convalidated) THEN
    ALTER TABLE "business_level_allocations" VALIDATE CONSTRAINT "business_level_allocations_level_id_fkey";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_members_level_id_fkey' AND NOT convalidated) THEN
    ALTER TABLE "business_members" VALIDATE CONSTRAINT "business_members_level_id_fkey";
  END IF;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "promotion_redemptions_promo_created_idx"
  ON "promotion_redemptions" ("promotion_id", "created_at" DESC);
