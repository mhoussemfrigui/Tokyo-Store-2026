-- 0151 — PARTNERSHIP APPLICATIONS (« Devenir partenaire » from /pro).
--
-- A public intake queue for companies applying to become B2B partners. SEPARATE
-- from `businesses`: an application is a REQUEST, promoted to a real business only
-- when an operator APPROVES it (approved_business_id links the two). Anyone may
-- apply — logged out (applicant_user_id NULL) or a signed-in customer (soft link,
-- no FK, same convention as business_members). Idempotent.
CREATE TABLE IF NOT EXISTS "business_applications" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "company_name" text NOT NULL,
  "tax_id" text,
  "contact_name" text,
  "contact_email" text NOT NULL,
  "contact_phone" text,
  "requested_pct" integer,
  "employee_count" integer,
  "message" text,
  "status" text NOT NULL DEFAULT 'pending',
  "applicant_user_id" text,
  "admin_notes" text,
  "reviewed_by" text,
  "reviewed_at" timestamp with time zone,
  "approved_business_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- status is one of the four lifecycle states.
ALTER TABLE "business_applications" DROP CONSTRAINT IF EXISTS "business_applications_status_chk";--> statement-breakpoint
ALTER TABLE "business_applications" ADD CONSTRAINT "business_applications_status_chk"
  CHECK ("status" IN ('pending', 'reviewing', 'approved', 'rejected'));--> statement-breakpoint
-- requested_pct, when set, is a percentage 0..100.
ALTER TABLE "business_applications" DROP CONSTRAINT IF EXISTS "business_applications_pct_chk";--> statement-breakpoint
ALTER TABLE "business_applications" ADD CONSTRAINT "business_applications_pct_chk"
  CHECK ("requested_pct" IS NULL OR ("requested_pct" >= 0 AND "requested_pct" <= 100));--> statement-breakpoint
-- employee_count, when set, is non-negative.
ALTER TABLE "business_applications" DROP CONSTRAINT IF EXISTS "business_applications_emp_chk";--> statement-breakpoint
ALTER TABLE "business_applications" ADD CONSTRAINT "business_applications_emp_chk"
  CHECK ("employee_count" IS NULL OR "employee_count" >= 0);--> statement-breakpoint
-- Queue: filter by status + newest-first, and the per-status counts (the badge/stats).
CREATE INDEX IF NOT EXISTS "business_applications_status_created_idx"
  ON "business_applications" ("status", "created_at");--> statement-breakpoint
-- Default « toutes » view — newest first, id as the stable tiebreaker.
CREATE INDEX IF NOT EXISTS "business_applications_created_idx"
  ON "business_applications" ("created_at" DESC, "id" DESC);--> statement-breakpoint
-- "Has this signed-in customer already applied?" + link on approval (partial: only rows with an applicant).
CREATE INDEX IF NOT EXISTS "business_applications_applicant_idx"
  ON "business_applications" ("applicant_user_id") WHERE "applicant_user_id" IS NOT NULL;--> statement-breakpoint
-- The business created on approval (a company can be deleted later without losing the application trail).
ALTER TABLE "business_applications" DROP CONSTRAINT IF EXISTS "business_applications_approved_business_id_fkey";--> statement-breakpoint
ALTER TABLE "business_applications" ADD CONSTRAINT "business_applications_approved_business_id_fkey"
  FOREIGN KEY ("approved_business_id") REFERENCES "businesses"("id") ON DELETE SET NULL;
