-- Settlement lookup performance.
--
-- Every gateway webhook (/api/webhooks/flouci), the customer-return
-- verify, and the /api/cron/payments reconcile sweep resolve the order via
-- orderService.findByPaymentReference — an `eq(orders.payment_reference, …)`
-- that had NO index, so each settlement hit seq-scanned the orders table. Most
-- orders (COD / offline) carry a NULL reference, so a PARTIAL index keeps it
-- small and only covers the gateway-paid rows it serves.
--
-- Non-unique on purpose: gateway references are effectively unique, but
-- admin-set offline references (the payment-reference form) are not guaranteed
-- unique, so a unique index could reject a legitimate duplicate. NOT
-- CONCURRENTLY (the drizzle migrator wraps the batch in one transaction).
CREATE INDEX IF NOT EXISTS "orders_payment_reference_idx"
  ON "orders" ("payment_reference")
  WHERE "payment_reference" IS NOT NULL;
