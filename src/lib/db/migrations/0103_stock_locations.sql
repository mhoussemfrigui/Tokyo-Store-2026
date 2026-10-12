-- 0103 — multi-location inventory foundation (OPT-IN).
--
-- Adds stock LOCATIONS (stores/depots) + a per-location stock DETAIL table.
-- Multi-location is off by default (setting `inventory.location_mode` = shared):
-- one seeded "Magasin principal" holds everything and `products.stock_qty` /
-- `product_variants.stock_qty` stay the authoritative sellable totals. When the
-- operator switches to per-location mode, `stock_levels` becomes the editable
-- per-store detail and the totals are the cached SUM across active locations.
--
-- This migration is structural + a one-time backfill; it changes NO runtime
-- behaviour on its own (the order decrement still uses the totals).

-- ── 1) Locations ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "stock_locations" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "name" text NOT NULL,
  "code" text,
  "carrier_ref" text,
  "is_default" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "display_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);
-- At most one default location store-wide (mirrors the one-default-variant idx).
CREATE UNIQUE INDEX IF NOT EXISTS "stock_locations_one_default"
  ON "stock_locations" ("is_default") WHERE "is_default" AND "deleted_at" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "stock_locations_code_unique"
  ON "stock_locations" ("code") WHERE "code" IS NOT NULL AND "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "stock_locations_display_order_idx"
  ON "stock_locations" ("display_order");

-- Seed the default location (only when none exists — idempotent).
INSERT INTO "stock_locations" ("name", "is_default", "display_order")
SELECT 'Magasin principal', true, 0
WHERE NOT EXISTS (SELECT 1 FROM "stock_locations" WHERE "deleted_at" IS NULL);

-- ── 2) Per-location levels ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "stock_levels" (
  "id" uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  "location_id" uuid NOT NULL REFERENCES "stock_locations"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "variant_id" uuid REFERENCES "product_variants"("id") ON DELETE CASCADE,
  "qty" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "stock_levels_qty_nonneg" CHECK ("qty" >= 0)
);
-- Split partial uniques: a NULL variant_id (product pool) row vs per-variant rows.
CREATE UNIQUE INDEX IF NOT EXISTS "stock_levels_product_pool_unique"
  ON "stock_levels" ("location_id", "product_id") WHERE "variant_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "stock_levels_variant_unique"
  ON "stock_levels" ("location_id", "variant_id") WHERE "variant_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "stock_levels_product_idx" ON "stock_levels" ("product_id");
CREATE INDEX IF NOT EXISTS "stock_levels_variant_idx"
  ON "stock_levels" ("variant_id") WHERE "variant_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "stock_levels_location_idx" ON "stock_levels" ("location_id");

-- ── 3) Backfill the default location's levels from the current totals ──────
-- Tracked rows only (NULL stock_qty = untracked = unlimited = no level row).
-- Per-row NOT EXISTS guard makes the backfill idempotent on re-run.
INSERT INTO "stock_levels" ("location_id", "product_id", "variant_id", "qty")
SELECT loc.id, p.id, NULL, p.stock_qty
FROM "products" p
CROSS JOIN (SELECT id FROM "stock_locations" WHERE "is_default" AND "deleted_at" IS NULL LIMIT 1) loc
WHERE p.stock_qty IS NOT NULL
  AND p.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "stock_levels" sl
    WHERE sl.location_id = loc.id AND sl.product_id = p.id AND sl.variant_id IS NULL
  );

INSERT INTO "stock_levels" ("location_id", "product_id", "variant_id", "qty")
SELECT loc.id, v.product_id, v.id, v.stock_qty
FROM "product_variants" v
CROSS JOIN (SELECT id FROM "stock_locations" WHERE "is_default" AND "deleted_at" IS NULL LIMIT 1) loc
WHERE v.stock_qty IS NOT NULL
  AND v.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "stock_levels" sl
    WHERE sl.location_id = loc.id AND sl.variant_id = v.id
  );

-- ── 4) Ledger gains a location dimension ──────────────────────────────────
-- Nullable: pre-multi-location movements stay NULL; future per-location writes
-- record the store the change happened at (for per-location reconciliation).
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "location_id" uuid;
