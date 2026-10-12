DROP TABLE IF EXISTS "digital_assets";--> statement-breakpoint
DROP TYPE IF EXISTS "digital_asset_type";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN IF EXISTS "is_digital";
