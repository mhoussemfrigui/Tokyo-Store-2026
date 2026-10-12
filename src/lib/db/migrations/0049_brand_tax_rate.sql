-- 0049 — Per-brand TVA rate (the brand tier of the tax cascade). Idempotent.
-- NULL = inherit; sits between the filter tier and the category tier:
--   product → filter (tax_rules) → brand → category → global.
ALTER TABLE "brands" ADD COLUMN IF NOT EXISTS "tax_rate_bps" integer;
