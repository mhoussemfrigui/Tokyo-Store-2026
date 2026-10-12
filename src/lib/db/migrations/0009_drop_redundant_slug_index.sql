-- products_active_slug_idx is a NON-unique btree on (slug) WHERE deleted_at IS
-- NULL — functionally identical to the partial UNIQUE index products_slug_unique
-- (same column + predicate), which serves every slug-equality lookup. The
-- duplicate only adds write overhead, so drop it; the planner falls back to the
-- unique index transparently. Idempotent.
DROP INDEX IF EXISTS "products_active_slug_idx";
