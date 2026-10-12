-- 0165 — order spam-triage flag.
--
-- Lets an operator classify a junk order (fake gateway abandons, bot orders) as
-- spam. A flagged order drops out of the default Commandes list AND the « À traiter »
-- queue (actionableOrderSql excludes it), so the fulfilment view stays clean, but it
-- remains reachable via the « Spam » filter for review / bulk cancellation.
--
--   flagged_spam_at        — WHEN it was flagged (NULL = not spam). The single source
--                            of truth for the flag; every list/queue predicate keys on
--                            `flagged_spam_at IS [NOT] NULL`.
--   flagged_spam_by_user_id — WHO flagged it (audit; also emitted on order.edited).
--
-- The partial index serves the « Spam » filter's keyset (created_at DESC, id DESC)
-- over the SMALL flagged subset — the default (non-spam) path is almost the whole
-- table, so it rides the existing orders_created_at_idx and needs no new index.
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "flagged_spam_at" timestamptz;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "flagged_spam_by_user_id" text;

CREATE INDEX IF NOT EXISTS "orders_flagged_spam_idx"
  ON "orders" ("created_at" DESC, "id" DESC)
  WHERE "flagged_spam_at" IS NOT NULL;
