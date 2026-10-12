-- 0053 — Offline payment methods for operator-created orders. Idempotent.
-- `cash` (counter) + `bank_transfer` (wire) settle UP FRONT (kept in
-- UPFRONT_PAID_METHODS), so a manual order paid offline can be marked `paid`.
-- COD stays pay-on-delivery. (PG16 allows ADD VALUE inside the migrator tx as
-- long as the value isn't used in the same tx — it isn't.)
ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'cash';--> statement-breakpoint
ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'bank_transfer';
