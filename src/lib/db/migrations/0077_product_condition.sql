-- Product CONDITION (état): new | used | refurbished.
-- Drives the schema.org Offer.itemCondition + a storefront "État" row. NOT NULL
-- with a 'new' default so every existing row backfills to brand-new (the common
-- case) and the JSON-LD keeps emitting NewCondition unchanged. CHECK pins the
-- allowed set (mirrors the zod enum the app validates with). No index — read
-- with the product row, never filtered/joined on.
ALTER TABLE "products"
  ADD COLUMN IF NOT EXISTS "condition" text NOT NULL DEFAULT 'new';

ALTER TABLE "products"
  ADD CONSTRAINT "products_condition_check"
  CHECK ("condition" IN ('new', 'used', 'refurbished'));
