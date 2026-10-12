-- Phase 6 — business (B2B) accounts. DISABLED BY DEFAULT (gated by the
-- auth.business.enabled site setting); the tables just need to exist so the
-- feature can be switched on later with no migration.
--
--   businesses        — companies.
--   business_members  — which users (employees) belong to a company; is_partner
--                       marks a company admin. user_id is a soft text link to
--                       auth.users (no cross-module FK); business_id is an
--                       intra-module FK (ON DELETE CASCADE).
--   promotions.business_id — orthogonal buyer-eligibility filter (company-scoped
--                       promos). NULL on every existing promo → no behaviour
--                       change until set.
-- Idempotent: IF [NOT] EXISTS throughout.
CREATE TABLE IF NOT EXISTS "businesses" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "name" text NOT NULL,
  "slug" text,
  "tax_id" text,
  "contact_email" text,
  "contact_phone" text,
  "notes" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "businesses_slug_unique"
  ON "businesses" ("slug")
  WHERE "slug" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "businesses_created_at_idx" ON "businesses" ("created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_members" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "business_id" uuid NOT NULL REFERENCES "businesses"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "is_partner" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_members_business_user_unique"
  ON "business_members" ("business_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_members_user_idx" ON "business_members" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "business_members_business_idx" ON "business_members" ("business_id");--> statement-breakpoint
ALTER TABLE "promotions" ADD COLUMN IF NOT EXISTS "business_id" uuid;
