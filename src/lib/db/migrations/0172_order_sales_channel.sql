-- 0172 — sales-channel capture (GZ parity, Phase D P2).
--
-- Records WHERE each order originated so the admin can filter Commandes by
-- « Origine / Canal ». Set once at placement from the workflow context:
--   storefront — customer self-checkout (the default)
--   operator   — staff « Nouvelle commande » (manual order)
--   express    — one-tap achat express / quick-buy
--   erp        — pushed in by an external ERP/WMS over the keyed order API
-- No wholesale/B2B channel (owner directive). The enum TYPE must exist before the
-- column, so create it first (idempotent via the duplicate_object guard).
DO $$ BEGIN
  CREATE TYPE "order_channel" AS ENUM ('storefront', 'operator', 'express', 'erp');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "channel" "order_channel" NOT NULL DEFAULT 'storefront';--> statement-breakpoint

-- No backfill: historical rows keep the 'storefront' default. `external_ref` is a
-- two-way ERP LINK key (set at creation by the ERP inbound path, but ALSO stamped on
-- ANY existing order later via order.set_external_ref for fulfillment/sync), so it is
-- NOT a reliable origin marker — backfilling channel='erp' WHERE external_ref IS NOT
-- NULL would mis-classify a storefront/express/operator order that was merely
-- ERP-linked afterward. There is no dependable historical origin signal, so channel
-- is authoritative only from placement forward; leaving old rows 'storefront' is the
-- honest default (reporting-only, no money/stock impact).

-- Filter + keyset support: the admin list orders by (created_at DESC, id DESC) and
-- filters by channel; a composite keeps a channel chip's page a range scan (the
-- large 'storefront' bucket still rides orders_created_at_idx).
CREATE INDEX IF NOT EXISTS "orders_channel_created_idx"
  ON "orders" ("channel", "created_at" DESC, "id" DESC);
