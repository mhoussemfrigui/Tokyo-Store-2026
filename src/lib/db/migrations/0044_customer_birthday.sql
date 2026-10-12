-- 0044 — Optional customer birthday (date only) on customer_profiles.
-- Nullable, no default (NULL until the customer/admin sets it), no index
-- (the birthday_month dynamic-segment rule is evaluated in-memory off the hot
-- per-line path, never via a birthday WHERE clause). Idempotent.
ALTER TABLE "customer_profiles" ADD COLUMN IF NOT EXISTS "birthday" date;
