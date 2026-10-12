-- 0175 — Pages block-composer storage + per-page SEO.
--
-- `pages.blocks` is the instance-based block layout (a JSON array of
-- {id, type, visible, config}) — the successor to the relational page_sections, mirroring
-- home.blocks. Nullable + additive: when NULL/empty the reader SYNTHESISES blocks from the
-- existing page_sections (non-destructive rollover), so every page renders identically
-- until an operator saves in the new composer. No backfill.
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "blocks" text;--> statement-breakpoint

-- Per-page SEO the resolver lacked (other entities on /[slug] already have these):
--   canonical_url — an explicit canonical override (blank → the page's own URL);
--   noindex       — keep a thin/duplicate page out of search (emits robots noindex +
--                   suppresses its JSON-LD), default false = indexable as today.
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "canonical_url" text;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN IF NOT EXISTS "noindex" boolean NOT NULL DEFAULT false;
