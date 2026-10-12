-- Admin order-search performance.
--
-- OrderService.list (src/modules/order/service.ts) matches a leading-wildcard
-- ILIKE on order_number / contact_email / contact_phone:
--   or(ilike(order_number,'%t%'), ilike(contact_email,'%t%'), ilike(contact_phone,'%t%'))
-- A `%term%` substring match cannot use a btree (not even the existing
-- functional upper(order_number) / lower(contact_email) / phone-digits indexes),
-- so the admin order search seq-scanned the orders table. The customer search
-- got trigram GINs in 0037; orders were the remaining gap. All three predicates
-- are on the SAME table, so the planner BitmapOrs these three GIN indexes
-- directly (no join restructuring needed, unlike the customer case).
--
-- pg_trgm is enabled in the baseline. Email/phone are nullable (trigram GIN
-- simply skips NULLs); order_number is NOT NULL. NOT CONCURRENTLY: the drizzle
-- migrator wraps the batch in one transaction, and CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block.
CREATE INDEX IF NOT EXISTS "orders_order_number_trgm"
  ON "orders" USING gin ("order_number" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_contact_email_trgm"
  ON "orders" USING gin ("contact_email" gin_trgm_ops)
  WHERE "contact_email" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_contact_phone_trgm"
  ON "orders" USING gin ("contact_phone" gin_trgm_ops)
  WHERE "contact_phone" IS NOT NULL;
