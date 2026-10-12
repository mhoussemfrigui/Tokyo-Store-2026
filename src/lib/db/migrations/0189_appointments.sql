-- 0189 — Rendez-Vous (appointments). Add-only, idempotent.
--
-- Three tables: appointment_locations (where + capacity config), appointment_reasons
-- (admin-editable; `requires_product` flags the « try a watch » reason), appointments
-- (a booking by a logged-in user OR a guest, capacity-checked against the location's
-- operators-per-slot). reason_id / location_id / product_id are SET NULL / soft links;
-- the chosen reason label, location name + product title are snapshot onto the row so
-- history survives later config edits.
CREATE TABLE IF NOT EXISTS "appointment_locations" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "name" text NOT NULL,
  "address" text,
  "info" text,
  "slot_length_minutes" integer NOT NULL DEFAULT 30,
  "operators" integer NOT NULL DEFAULT 1,
  "opening_hours" jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  "display_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "appointment_locations_slot_len_check" CHECK ("slot_length_minutes" BETWEEN 5 AND 480),
  CONSTRAINT "appointment_locations_operators_check" CHECK ("operators" BETWEEN 0 AND 100)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointment_locations_active_order_idx" ON "appointment_locations" ("is_active", "display_order");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "appointment_reasons" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "label" text NOT NULL,
  "requires_product" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "display_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointment_reasons_active_order_idx" ON "appointment_reasons" ("is_active", "display_order");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "appointments" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
  "reason_id" uuid,
  "reason_label" text NOT NULL,
  "location_id" uuid,
  "location_name" text NOT NULL,
  "user_id" text,
  "customer_name" text NOT NULL,
  "customer_email" text NOT NULL,
  "customer_phone" text,
  "preferred_contact_time" text,
  "product_id" uuid,
  "product_title" text,
  "appointment_date" date NOT NULL,
  "slot_time" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  CONSTRAINT "appointments_status_check" CHECK ("status" IN ('pending', 'confirmed', 'declined', 'cancelled', 'completed'))
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_reason_fk') THEN
    ALTER TABLE "appointments"
      ADD CONSTRAINT "appointments_reason_fk"
      FOREIGN KEY ("reason_id") REFERENCES "appointment_reasons"("id") ON DELETE SET NULL;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_location_fk') THEN
    ALTER TABLE "appointments"
      ADD CONSTRAINT "appointments_location_fk"
      FOREIGN KEY ("location_id") REFERENCES "appointment_locations"("id") ON DELETE SET NULL;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_status_created_idx" ON "appointments" ("status", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_user_created_idx" ON "appointments" ("user_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_slot_idx" ON "appointments" ("location_id", "appointment_date", "slot_time");--> statement-breakpoint
-- Seed the two default reasons ONLY when the table is empty (first install). An
-- admin can then rename / reorder / add / deactivate them freely.
INSERT INTO "appointment_reasons" ("label", "requires_product", "display_order")
SELECT * FROM (VALUES
  ('Consultation', false, 0),
  ('Essayer une montre', true, 1)
) AS seed("label", "requires_product", "display_order")
WHERE NOT EXISTS (SELECT 1 FROM "appointment_reasons");
