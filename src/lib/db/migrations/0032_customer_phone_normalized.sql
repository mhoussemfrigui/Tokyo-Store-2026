-- Phase 0 — customer phone normalization + guest-order phone index.
--
-- Add a digits-only mirror of customer_profiles.phone so admin search +
-- guest↔customer matching compare numbers entered in different formats
-- ("+216 12 345 678" == "21612345678") without a per-row functional scan.
-- customerService maintains it on insert/update via normalizePhoneDigits; this
-- backfills the existing rows. Partial index keeps it tight (NULLs excluded).
ALTER TABLE "customer_profiles" ADD COLUMN IF NOT EXISTS "phone_normalized" text;--> statement-breakpoint
UPDATE "customer_profiles"
  SET "phone_normalized" = regexp_replace("phone", '\D', '', 'g')
  WHERE "phone" IS NOT NULL
    AND "phone_normalized" IS NULL
    AND regexp_replace("phone", '\D', '', 'g') <> '';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_profiles_phone_norm_idx"
  ON "customer_profiles" ("phone_normalized")
  WHERE "phone_normalized" IS NOT NULL;--> statement-breakpoint
-- Functional index backing the digits-normalized guest-order phone match
-- (orderService.claimGuestOrders + listOrdersByPhone). Mirrors the SQL-only
-- orders_contact_email_lower_idx convention — kept out of the Drizzle snapshot.
CREATE INDEX IF NOT EXISTS "orders_contact_phone_norm_idx"
  ON "orders" ((regexp_replace("contact_phone", '\D', '', 'g')))
  WHERE "contact_phone" IS NOT NULL;
