-- 0139 — Collection parity with categories + brands (collections parity pass):
-- ERP linkage by reference, and dropping a non-selective standalone sort index.
--
-- (1) external_ref — a stable, opaque code from an EXTERNAL system (ERP / PIM /
--     marketplace) for linking & syncing a collection BY REFERENCE over the new
--     /api/collections endpoint. Unique among LIVE collections (partial, mirrors
--     categories_external_ref_unique / brands_external_ref_unique). New column →
--     all NULL, so the index builds trivially (no dedupe needed) and NULL
--     external_ref never collides.
-- (2) DROP collections_display_order_idx — collections are FLAT (no parent), so a
--     pure (display_order) btree is not selective at collection-table scale
--     (dozens–low hundreds): every reader orders the WHOLE live/active set, which
--     seq-scans + sorts regardless of the index. This mirrors the brands 0138
--     decision (no standalone sort index for the flat brand list) and the
--     categories 0137 memo, which dropped exactly such a standalone index in
--     favour of a parent-scoped composite (collections have no parent, so there
--     is nothing to compose — just drop it).
--
-- NOTE: intentionally NO is_discountable on collections. Collections are
-- many-to-many (a product can belong to several), so an OR-semantics "blocked if
-- in ANY non-discountable collection" opt-out is a pricing footgun — the
-- product / category / brand opt-outs already cover every real case. (owner call)

ALTER TABLE "collections" ADD COLUMN IF NOT EXISTS "external_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "collections_external_ref_unique"
  ON "collections" ("external_ref") WHERE "external_ref" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS "collections_display_order_idx";
