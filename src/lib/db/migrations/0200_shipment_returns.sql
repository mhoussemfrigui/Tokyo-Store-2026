-- 0200 — « Retour d'expédition » : returns that are not a classic SAV/RMA but a
-- SHIPPED parcel that never reached the customer (unreachable / wrong address /
-- refused) and bounced back to the store (RTO). Modelled as a KIND of the
-- existing return so the restock machinery is shared; receiving one additionally
-- cancels the order.
--
--   kind              'after_sale' (default — classic SAV) | 'shipment' (RTO).
--   carrier_name      external carrier/livreur that failed the delivery (snapshot).
--   tracking_ref      the carrier's tracking reference.
--   delivery_attempts number of failed delivery attempts.
--
-- Columns are additive + nullable (carrier/tracking/attempts) so every existing
-- return stays a valid `after_sale` row. The CHECK keeps the kind set closed.
ALTER TABLE "order_returns" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'after_sale';
ALTER TABLE "order_returns" ADD COLUMN IF NOT EXISTS "carrier_name" text;
ALTER TABLE "order_returns" ADD COLUMN IF NOT EXISTS "tracking_ref" text;
ALTER TABLE "order_returns" ADD COLUMN IF NOT EXISTS "delivery_attempts" integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'order_returns_kind_check'
  ) THEN
    ALTER TABLE "order_returns"
      ADD CONSTRAINT "order_returns_kind_check" CHECK ("kind" IN ('after_sale', 'shipment'));
  END IF;
END $$;

-- Backs the two per-kind Retours dashboards (filter kind → order by created_at desc).
CREATE INDEX IF NOT EXISTS "order_returns_kind_created_idx"
  ON "order_returns" ("kind", "created_at" DESC);
