-- 0132 — Snapshot the avoir (credit note) amount at issuance.
--
-- The printable avoir showed a LIVE-recomputed refund total (sum of
-- order_refunds at render time), so recording a further refund after the avoir
-- was numbered silently changed the amount printed on that already-issued,
-- dated fiscal document. Add a nullable snapshot column stamped when the credit
-- note number is drawn (issueCreditNoteAction); the invoice renderer prints the
-- snapshot when present and falls back to the live sum for avoirs issued before
-- this column existed. Additive + idempotent; no backfill (legacy avoirs keep
-- the live behaviour).

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "credit_note_amount_cents" integer;
