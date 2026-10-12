-- 0042 — Comprehensive promotions: bidirectional targeting + opt-outs + new params.
-- All idempotent (IF [NOT] EXISTS / pg_constraint-guarded NOT VALID FKs), per the
-- 0040/0041 pattern, so db:migrate converges identically on a fresh DB and the live DB.

-- ── promotion_targets: who a promo is RESTRICTED to. A promo with ANY targets
-- applies ONLY to a buyer matching one of them (customer / segment / business);
-- NO targets = public. Replaces the single promotions.business_id (kept, deprecated,
-- backfilled below). Multi-target by design (N customers + N segments + N businesses).
CREATE TABLE IF NOT EXISTS "promotion_targets" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "promotion_id" uuid NOT NULL,
  "target_type" text NOT NULL,
  "target_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "promotion_targets_type_chk" CHECK ("target_type" IN ('customer','segment','business'))
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotion_targets_promotion_id_fkey') THEN
    ALTER TABLE "promotion_targets" ADD CONSTRAINT "promotion_targets_promotion_id_fkey"
      FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_targets_promo_idx" ON "promotion_targets" ("promotion_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "promotion_targets_uniq" ON "promotion_targets" ("promotion_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "promotion_targets_lookup_idx" ON "promotion_targets" ("target_type","target_id");--> statement-breakpoint

-- ── customer_segments + members: reusable customer groupings for promo targeting.
-- kind='manual' → explicit member list; kind='dynamic' → `rule` resolved at
-- evaluate-time (e.g. min_lifetime_coins:1000, marketing_opted_in, no_orders).
CREATE TABLE IF NOT EXISTS "customer_segments" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "name" text NOT NULL,
  "kind" text NOT NULL DEFAULT 'manual',
  "rule" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "customer_segments_kind_chk" CHECK ("kind" IN ('manual','dynamic'))
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_segment_members" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "segment_id" uuid NOT NULL,
  "customer_profile_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_segment_members_segment_id_fkey') THEN
    ALTER TABLE "customer_segment_members" ADD CONSTRAINT "customer_segment_members_segment_id_fkey"
      FOREIGN KEY ("segment_id") REFERENCES "customer_segments"("id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_segment_members_uniq" ON "customer_segment_members" ("segment_id","customer_profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_segment_members_profile_idx" ON "customer_segment_members" ("customer_profile_id");--> statement-breakpoint

-- ── opt-out flags (the OPPOSITE gating direction — set from the customer/business side).
-- promo_opt_out: a customer suppresses PUBLIC promos for themselves.
-- exclude_public_promos: an active member of this business gets no PUBLIC promos
-- (their negotiated B2B rate is the deal). Targeted promos still apply in both cases.
ALTER TABLE "customer_profiles" ADD COLUMN IF NOT EXISTS "promo_opt_out" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "exclude_public_promos" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- ── new promotion parameters.
-- stack_with_member_discount: per-promo override of the global member-vs-promo
-- stacking setting. NULL = inherit the loyalty setting; true = always stacks;
-- false = never stacks with the member/loyalty discount.
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "stack_with_member_discount" boolean;--> statement-breakpoint
-- max_discount_cents: cap a percent discount's value (millimes). NULL = uncapped.
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "max_discount_cents" integer;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promotions_max_discount_chk') THEN
    ALTER TABLE "promotions" ADD CONSTRAINT "promotions_max_discount_chk"
      CHECK ("max_discount_cents" IS NULL OR "max_discount_cents" >= 1) NOT VALID;
  END IF;
END $$;--> statement-breakpoint
-- grants_free_shipping: the promo zeroes shipping (orthogonal to any line discount).
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "grants_free_shipping" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- Relax the discount-bounds CHECK so a FREE-SHIPPING-ONLY promo (value 0) is legal.
-- Existing rows all satisfy the percent/fixed clauses, so the re-add validates cheaply.
ALTER TABLE "promotions" DROP CONSTRAINT IF EXISTS "promotions_discount_bounds_chk";--> statement-breakpoint
ALTER TABLE "promotions" ADD CONSTRAINT "promotions_discount_bounds_chk" CHECK (
  ("discount_type" = 'percent' AND "discount_value" BETWEEN 1 AND 100)
  OR ("discount_type" = 'fixed' AND "discount_value" >= 1)
  OR ("grants_free_shipping" = true AND "discount_value" = 0)
);--> statement-breakpoint

-- ── Backfill: migrate the legacy single business_id into promotion_targets so the
-- new eligibility path is authoritative. business_id stays for one release (no
-- longer read by eligibility). Only live, business-scoped rows.
INSERT INTO "promotion_targets" ("promotion_id","target_type","target_id")
SELECT "id", 'business', "business_id" FROM "promotions"
WHERE "business_id" IS NOT NULL AND "deleted_at" IS NULL
ON CONFLICT DO NOTHING;
