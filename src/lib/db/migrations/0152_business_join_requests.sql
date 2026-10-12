-- 0152 — B2B JOIN-BY-CODE onboarding.
--
-- (1) A short, human-typeable join CODE per level allocation, alongside the long
-- opaque invite_token URL. The employer shares the code; an employee types it in
-- « Mon compte » to REQUEST to join that company at that level. Idempotent.
ALTER TABLE "business_level_allocations" ADD COLUMN IF NOT EXISTS "join_code" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_level_alloc_join_code_uq"
  ON "business_level_allocations" ("join_code") WHERE "join_code" IS NOT NULL;--> statement-breakpoint

-- (2) Employee JOIN REQUESTS — a code submission (or any request-to-join) becomes
-- a pending row the employer ACCEPTS (→ member at that level) or REJECTS. Separate
-- from business_members (a request is not yet a membership) and from
-- business_applications (that is a company applying to become a partner; this is an
-- employee applying to join an EXISTING partner).
CREATE TABLE IF NOT EXISTS "business_join_requests" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "business_id" uuid NOT NULL,
  -- The level requested (resolved from the code). SET NULL if that level is later
  -- hard-deleted — the request trail survives; the employer re-picks a level on accept.
  "level_id" uuid,
  -- The requesting employee's account (soft link to auth.users, no cross-module FK).
  "user_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "note" text,
  "reviewed_by" text,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "business_join_requests" DROP CONSTRAINT IF EXISTS "business_join_requests_status_chk";--> statement-breakpoint
ALTER TABLE "business_join_requests" ADD CONSTRAINT "business_join_requests_status_chk"
  CHECK ("status" IN ('pending', 'approved', 'rejected'));--> statement-breakpoint
-- Cascade requests with the company; keep the trail if the level is hard-deleted.
ALTER TABLE "business_join_requests" DROP CONSTRAINT IF EXISTS "business_join_requests_business_id_fkey";--> statement-breakpoint
ALTER TABLE "business_join_requests" ADD CONSTRAINT "business_join_requests_business_id_fkey"
  FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "business_join_requests" DROP CONSTRAINT IF EXISTS "business_join_requests_level_id_fkey";--> statement-breakpoint
ALTER TABLE "business_join_requests" ADD CONSTRAINT "business_join_requests_level_id_fkey"
  FOREIGN KEY ("level_id") REFERENCES "business_levels"("id") ON DELETE SET NULL;--> statement-breakpoint
-- At most ONE open (pending) request per (business, user) — no duplicate asks.
CREATE UNIQUE INDEX IF NOT EXISTS "business_join_requests_one_pending_uq"
  ON "business_join_requests" ("business_id", "user_id") WHERE "status" = 'pending';--> statement-breakpoint
-- Employer queue: filter by business + status, newest first.
CREATE INDEX IF NOT EXISTS "business_join_requests_biz_status_idx"
  ON "business_join_requests" ("business_id", "status", "created_at" DESC);--> statement-breakpoint
-- "My requests" (the employee's own, across companies).
CREATE INDEX IF NOT EXISTS "business_join_requests_user_idx"
  ON "business_join_requests" ("user_id");
