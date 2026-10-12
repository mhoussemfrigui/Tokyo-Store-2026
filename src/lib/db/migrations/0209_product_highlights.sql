-- 0209 — Re-add the product "Caractéristiques clés" (key-feature bullets).
-- The original `product_highlights` table was dropped in 0102 when the feature was
-- bundled into the AI-generation removal. It is restored here as an operator-curated,
-- ordered, VARIABLE-count list of free-text bullets shown on the PDP (the
-- « Neuf · testé… / Facture officielle… » chips). Stored as a jsonb string[] so
-- bullet order is preserved without a child table. DEFAULT '[]' so every existing
-- product reads as "no curated highlights" (the storefront then falls back to
-- attribute specs, then a derived marketing default). NOT NULL to match the schema
-- and keep readers branch-free. Idempotent (IF NOT EXISTS) so a partial apply re-runs.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "highlights" jsonb NOT NULL DEFAULT '[]'::jsonb;
