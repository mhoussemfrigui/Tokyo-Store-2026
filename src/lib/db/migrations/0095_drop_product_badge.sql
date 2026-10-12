-- Drop the manual product badge (NEW/HOT/PROMO/PRECO). The storefront card now
-- renders COMPUTED tags instead — per-product tier exclusivity/drip (Stage B)
-- + the product's collection (Stage A) — resolved server-side in the listing
-- mapper, plus the live discount tag already computed in the card. The manual
-- badge column + its enum type are no longer read or written anywhere.
ALTER TABLE "products" DROP COLUMN IF EXISTS "badge";
--> statement-breakpoint
DROP TYPE IF EXISTS "product_badge";
