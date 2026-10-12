-- 0051 — Operator pick/pack verification: per-line "picked" stamp. Idempotent.
-- Stamped when an operator ticks a line as picked in the verification panel;
-- advisory (the hard ship gate is serial/digital-key presence, not this).
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "picked_at" timestamptz;
