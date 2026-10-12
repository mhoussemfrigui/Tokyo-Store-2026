-- Per-variant image snapshot on order lines.
--
-- order_items already snapshots variant_id / variant_sku / variant_label so a
-- line survives later variant edits. Add variant_image_url so the order /
-- invoice can show the EXACT variant photo the customer bought (frozen at
-- purchase, like product_image_url). NULL ⇒ the display falls back to
-- product_image_url. Backfills NULL on existing rows.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "variant_image_url" text;
