-- 0190 — Rendez-Vous: several montres per appointment. Add-only, idempotent.
--
-- A reason that requires a watch can now allow MORE THAN ONE: `max_products` caps
-- how many montres the customer picks (1 = one, N = up to N; admin-set per motif).
-- The chosen montres are snapshot as a jsonb array on the appointment
-- (`products` = [{"id","title"}]); the existing product_id / product_title keep the
-- FIRST (primary) one so the admin queue / account / emails need no back-compat shim.
ALTER TABLE "appointment_reasons" ADD COLUMN IF NOT EXISTS "max_products" integer NOT NULL DEFAULT 1;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointment_reasons_max_products_check') THEN
    ALTER TABLE "appointment_reasons"
      ADD CONSTRAINT "appointment_reasons_max_products_check" CHECK ("max_products" BETWEEN 1 AND 20);
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "products" jsonb;
