-- 0135 — CHECK constraints for stable status/kind text columns + drop a dead index.
--
-- Continues the 0134 hygiene pass. These columns carry a fixed value set the app
-- is the sole writer of, so an additive CHECK applies cleanly to existing rows and
-- turns a future typo'd/untyped write (e.g. an ERP requeue) into a loud 23514
-- instead of a silently-undeliverable/mis-filed row:
--   - webhook_deliveries.status — the drain filters WHERE status='queued'; an
--     invalid value would never be delivered and never surface as failed. Its
--     doc-comment already claims to "mirror email_logs", which HAS this CHECK.
--   - document_sequences.kind — the gapless fiscal counter key (invoice/avoir/BL).
--   - pickup_locations.kind — the pickup method (drive/in-store).
-- Also drops two_factors_secret_idx: a plain index on the AES-encrypted TOTP
-- `secret` column, never queried by value (the one-per-user lookup uses
-- two_factors_user_unique) — pure write/storage overhead.

DO $$ BEGIN
  ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_status_chk"
    CHECK ("status" IN ('queued', 'pending', 'delivered', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_kind_chk"
    CHECK ("kind" IN ('invoice', 'credit_note', 'delivery_note'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "pickup_locations" ADD CONSTRAINT "pickup_locations_kind_chk"
    CHECK ("kind" IN ('drive_by_pickup', 'in_store'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DROP INDEX IF EXISTS "two_factors_secret_idx";
