-- 0125 — Drop two redundant indexes + backfill the soft-deleted-product release.
--
-- 1) Redundant indexes (pure write cost, no read benefit):
--   - promotion_redemptions_promo_idx (promotion_id) is a leading-column prefix
--     of BOTH promotion_redemptions_user_idx (promotion_id, user_id) and
--     promotion_redemptions_promo_created_idx (promotion_id, created_at DESC),
--     which serve every promotion-scoped lookup and the promotions FK cascade.
--   - business_members_business_idx (business_id) is a leading-column prefix of
--     the UNIQUE business_members_business_user_unique (business_id, user_id),
--     which serves the "members of this business" lookups and the FK cascade.
--   Plain DROP INDEX (CONCURRENTLY can't run inside the migrator's transaction);
--   both tables are small, so the brief lock is negligible.
--
-- 2) Backfill for products soft-deleted BEFORE the product-delete workflow
--    started releasing what the tombstone kept holding. deleteProductWorkflow
--    now runs, in one tx: productService.softDelete (tombstone + product-pool
--    stock_levels), replaceVariants(id, []) (live variants: sku/gtin freed,
--    is_default cleared, soft-deleted at stock 0 / in_stock false, their
--    stock_levels dropped) and setProductAttributeValues(id, []) (attribute
--    assignments dropped). Older tombstones still held live variants — their
--    sku/gtin stayed reserved on the partial unique indexes (re-creating the
--    listing failed with « Ce SKU de variante est déjà utilisé »), their levels
--    kept counting in the Emplacements totals, and their attribute values stayed
--    "in use". Mirror that release for them. The variant tombstone takes the
--    product's own deleted_at (the runtime stamps both in the same tx). Like the
--    runtime, no stock ledger row is written (the product is no longer sellable)
--    and order history is unaffected (order_items snapshot sku / label / image).
--
-- Idempotent: IF EXISTS on the drops; every backfill statement only matches rows
-- still attached to a deleted product, so a re-run is a no-op.

DROP INDEX IF EXISTS "promotion_redemptions_promo_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "business_members_business_idx";
--> statement-breakpoint
UPDATE "product_variants" AS v
SET "sku" = NULL,
    "gtin" = NULL,
    "is_default" = false,
    "stock_qty" = 0,
    "in_stock" = false,
    "deleted_at" = p."deleted_at"
FROM "products" AS p
WHERE p."id" = v."product_id"
  AND p."deleted_at" IS NOT NULL
  AND v."deleted_at" IS NULL;
--> statement-breakpoint
DELETE FROM "stock_levels" AS sl
USING "products" AS p
WHERE p."id" = sl."product_id"
  AND p."deleted_at" IS NOT NULL;
--> statement-breakpoint
DELETE FROM "product_attribute_assignments" AS a
USING "products" AS p
WHERE p."id" = a."product_id"
  AND p."deleted_at" IS NOT NULL;
