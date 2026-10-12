-- Per-product schema.org `sameAs`: official external URLs that represent the
-- SAME product (manufacturer page, official store, authoritative listing).
-- Stored as newline-separated text, mirroring how the global seo.* sameAs /
-- knows_about lists are stored (read back through a list() splitter). NULL → no
-- sameAs. Surfaced in the Product JSON-LD ONLY when the global master switch
-- `seo.product_sameas_enabled` (admin SEO tab) is on. No index: the column is
-- read with its product row, never filtered/joined on — keeps writes cheap.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "same_as" text;
