-- 0040 — Loyalty dual-mode stacking + B2B levels / allocations / employee-levels.
-- All idempotent (IF [NOT] EXISTS / pg_constraint-guarded NOT VALID FKs), per the
-- 0039 pattern, so `db:migrate` converges identically on a fresh DB and the live DB.

-- ── Per-level promo-stacking overrides on the CONSUMER level ladder (coin_levels).
-- NULL = inherit the global `loyalty.stack.*` setting; true/false = override here.
ALTER TABLE "coin_levels" ADD COLUMN IF NOT EXISTS "stack_product_promos" boolean;--> statement-breakpoint
ALTER TABLE "coin_levels" ADD COLUMN IF NOT EXISTS "stack_code_promos" boolean;--> statement-breakpoint

-- ── Personal↔employee loyalty mode (per customer). NULL = AUTO (employee when an
-- active business member, else personal). Values: 'personal' | 'employee'.
ALTER TABLE "customer_profiles" ADD COLUMN IF NOT EXISTS "loyalty_mode" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_profiles_loyalty_mode_chk') THEN
    ALTER TABLE "customer_profiles"
      ADD CONSTRAINT "customer_profiles_loyalty_mode_chk"
      CHECK ("loyalty_mode" IS NULL OR "loyalty_mode" IN ('personal','employee')) NOT VALID;
  END IF;
END $$;--> statement-breakpoint

-- ── Business / employee level ladder — SEPARATE from coin_levels (employee levels
-- are admin-assigned, NOT points-promoted). Each level: a % discount + perks + a
-- default seat cap + per-level promo-stacking overrides.
CREATE TABLE IF NOT EXISTS "business_levels" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "name" text NOT NULL,
  "slug" text,
  "discount_pct" integer NOT NULL DEFAULT 0,
  "free_shipping_threshold_cents" integer,
  "seat_cap" integer,
  "stack_product_promos" boolean,
  "stack_code_promos" boolean,
  "enabled" boolean NOT NULL DEFAULT true,
  "display_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "business_levels_discount_pct_chk" CHECK ("discount_pct" >= 0 AND "discount_pct" <= 100),
  CONSTRAINT "business_levels_seat_cap_chk" CHECK ("seat_cap" IS NULL OR "seat_cap" >= 0),
  CONSTRAINT "business_levels_free_ship_chk" CHECK ("free_shipping_threshold_cents" IS NULL OR "free_shipping_threshold_cents" >= 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_levels_display_order_idx" ON "business_levels" ("display_order");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_levels_slug_unique" ON "business_levels" ("slug") WHERE "slug" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint

-- ── Per-business grants of a level: seats (quota, defaults to the level's
-- seat_cap when NULL) + an optional self-registration token.
CREATE TABLE IF NOT EXISTS "business_level_allocations" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "business_id" uuid NOT NULL,
  "level_id" uuid NOT NULL,
  "quota" integer,
  "invite_token" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "business_level_allocations_quota_chk" CHECK ("quota" IS NULL OR "quota" >= 0)
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_level_allocations_business_id_fkey') THEN
    ALTER TABLE "business_level_allocations"
      ADD CONSTRAINT "business_level_allocations_business_id_fkey"
      FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_level_allocations_level_id_fkey') THEN
    ALTER TABLE "business_level_allocations"
      ADD CONSTRAINT "business_level_allocations_level_id_fkey"
      FOREIGN KEY ("level_id") REFERENCES "business_levels"("id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_level_alloc_business_level_uq" ON "business_level_allocations" ("business_id","level_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_level_alloc_invite_token_uq" ON "business_level_allocations" ("invite_token") WHERE "invite_token" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_level_alloc_business_idx" ON "business_level_allocations" ("business_id");--> statement-breakpoint

-- ── Each employee's assigned business level (employees of one company can be on
-- DIFFERENT levels). NULL = member without an assigned level.
ALTER TABLE "business_members" ADD COLUMN IF NOT EXISTS "level_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_members_level_id_fkey') THEN
    ALTER TABLE "business_members"
      ADD CONSTRAINT "business_members_level_id_fkey"
      FOREIGN KEY ("level_id") REFERENCES "business_levels"("id") ON DELETE SET NULL NOT VALID;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_members_level_idx" ON "business_members" ("level_id");
