-- Shared variant stock mode. NULL = inherit the global default
-- (app_secrets catalog.variant_stock_shared_default); true = all variants of a
-- variable product share the parent stock_qty pool; false = per-variant stock.
-- Additive + idempotent; existing products stay NULL (= inherit, default OFF =
-- the classic per-variant behavior).
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "shared_variant_stock" boolean;
