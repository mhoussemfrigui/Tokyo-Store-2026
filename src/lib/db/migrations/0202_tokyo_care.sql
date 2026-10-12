-- 0202 — Tokyo Care: admin-managed bonus / extended-warranty PROTECTION plans
-- sold as a paid add-on on eligible products. Everything is admin-controlled
-- (pricing, eligibility, perks). Plans are ACTIVATED on products/categories via
-- care_plan_scope_targets (soft polymorphic targets, promotion-style), with
-- per-product include/exclude + flat price override via product_care. Money is
-- integer MILLIMES. The order charge is server-recomputed; a later migration
-- adds orders.care_cents + order_care_items for the snapshot.
CREATE TABLE IF NOT EXISTS "care_plans" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "external_ref" text,
  "description" text,
  "duration_months" integer NOT NULL DEFAULT 12,
  "pricing_mode" text NOT NULL DEFAULT 'percent',
  "price_cents" integer NOT NULL DEFAULT 0,
  "price_bps" integer NOT NULL DEFAULT 0,
  "price_round_to_cents" integer NOT NULL DEFAULT 0,
  "min_charge_cents" integer NOT NULL DEFAULT 0,
  "min_product_price_cents" integer NOT NULL DEFAULT 0,
  "require_warranty" boolean NOT NULL DEFAULT true,
  "applicable_conditions" jsonb,
  "perks" jsonb,
  "icon" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "display_priority" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "care_plans_pricing_mode_chk" CHECK ("pricing_mode" IN ('flat','percent')),
  CONSTRAINT "care_plans_duration_pos_chk" CHECK ("duration_months" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "care_plans_slug_unique" ON "care_plans" ("slug") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "care_plans_external_ref_unique" ON "care_plans" ("external_ref") WHERE "external_ref" IS NOT NULL AND "deleted_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "care_plan_scope_targets" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "care_plan_id" uuid NOT NULL,
  "target_type" text NOT NULL,
  "target_id" uuid NOT NULL,
  "include_descendants" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "care_scope_target_type_chk" CHECK ("target_type" IN ('product','category')),
  CONSTRAINT "care_scope_plan_fk" FOREIGN KEY ("care_plan_id") REFERENCES "care_plans"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "care_scope_uniq" ON "care_plan_scope_targets" ("care_plan_id","target_type","target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_scope_lookup_idx" ON "care_plan_scope_targets" ("target_type","target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "care_scope_plan_idx" ON "care_plan_scope_targets" ("care_plan_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_care" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "product_id" uuid NOT NULL,
  "care_plan_id" uuid NOT NULL,
  "mode" text NOT NULL DEFAULT 'include',
  "override_price_cents" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "product_care_mode_chk" CHECK ("mode" IN ('include','exclude')),
  CONSTRAINT "product_care_plan_fk" FOREIGN KEY ("care_plan_id") REFERENCES "care_plans"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prodcare_pair_unique" ON "product_care" ("product_id","care_plan_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prodcare_product_idx" ON "product_care" ("product_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prodcare_plan_idx" ON "product_care" ("care_plan_id");
