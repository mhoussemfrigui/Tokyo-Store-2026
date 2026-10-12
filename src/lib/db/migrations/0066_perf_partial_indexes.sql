-- 0066 — two partial indexes for admin-list / dashboard hot paths.
--
-- 1. orders_guest_groupby_idx — listGuestClients (src/modules/order/queries.ts)
--    groups EVERY guest order by (lower(contact_email), contact_phone) WHERE
--    user_id IS NULL, then sorts by MAX(created_at). The existing single-column
--    indexes (orders_contact_email_lower_idx, orders_contact_phone_idx) can't
--    satisfy the two-column grouping, so the planner falls back to a seq-scan +
--    hash-aggregate over all guest orders. A partial composite index on the two
--    grouping keys (live guest rows only) lets it aggregate from the index.
--
-- 2. customer_profiles_live_created_idx — getCustomerStats
--    (src/modules/customer/queries.ts) runs two COUNTs over live profiles
--    (total + created in last 30 days) on every admin dashboard / analytics
--    load. The baseline created_at index includes soft-deleted rows; a partial
--    index on created_at WHERE deleted_at IS NULL backs BOTH counts directly.
--
-- Both idempotent (IF NOT EXISTS). Index-only DDL — no data change.

CREATE INDEX IF NOT EXISTS "orders_guest_groupby_idx"
  ON "orders" (lower("contact_email"), "contact_phone")
  WHERE "user_id" IS NULL;

CREATE INDEX IF NOT EXISTS "customer_profiles_live_created_idx"
  ON "customer_profiles" ("created_at")
  WHERE "deleted_at" IS NULL;
