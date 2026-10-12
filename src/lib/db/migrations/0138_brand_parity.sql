-- 0138 — Brand parity with categories (marques parity pass): manual ordering,
-- discount opt-out, and the tax-rate CHECK brands were missing.
--
-- (1) display_order — brands were alphabetical-only with no way to curate which
--     surface first on /marques + the nav strip. Add the column and BACKFILL from
--     the current name order (0-based, live rows) so today's ordering is exactly
--     preserved — non-disruptive. Brands are FLAT (no parent), so there is no
--     parent-scoped composite; a pure (display_order) sort index is not selective
--     at brand-table scale (dozens–hundreds) — the categories 0137 memo dropped
--     exactly such a standalone index — so we add NO index here (revisit only if
--     the brand count ever grows large).
-- (2) is_discountable — a per-brand "never discountable" opt-out, mirroring
--     categories.is_discountable, so a MAP/luxury house can be flagged in ONE
--     place instead of per product. The discount engine gains a brand tier.
-- (3) brands_tax_rate_bps_range CHECK — brands is the only tax tier (product /
--     category / brand) without the 0–10000 bps DB CHECK; add it for parity (the
--     Zod guard already enforces this, so no existing row is out of range).

ALTER TABLE brands ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0;

WITH o AS (
  SELECT id, (row_number() OVER (ORDER BY name)) - 1 AS n
  FROM brands
  WHERE deleted_at IS NULL
)
UPDATE brands b SET display_order = o.n FROM o WHERE b.id = o.id;

ALTER TABLE brands ADD COLUMN IF NOT EXISTS is_discountable boolean NOT NULL DEFAULT true;

ALTER TABLE brands DROP CONSTRAINT IF EXISTS brands_tax_rate_bps_range;
ALTER TABLE brands ADD CONSTRAINT brands_tax_rate_bps_range
  CHECK ((tax_rate_bps >= 0) AND (tax_rate_bps <= 10000));
