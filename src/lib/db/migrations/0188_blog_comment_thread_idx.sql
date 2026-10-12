-- 0188 — Index the comment-thread keyset. Add-only, idempotent.
--
-- listApprovedTopLevel filters (post_id =, parent_id IS NULL, status='approved',
-- deleted_at IS NULL, id < cursor) ORDER BY id DESC. post_status_created_idx only
-- covers the post_id+status prefix, so the keyset falls back to a sort of the
-- post's whole approved set per page. This partial index leads with post_id
-- (equality) then id DESC (serving BOTH the id<cursor range bound and the ORDER
-- BY), with the parent_id/status/deleted_at filters folded into the predicate —
-- turning the scan+sort into an index range seek. getAggregate (same predicate,
-- rating IS NOT NULL) benefits too.
CREATE INDEX IF NOT EXISTS "blog_comments_post_toplevel_idx"
  ON "blog_comments" ("post_id", "id" DESC)
  WHERE "parent_id" IS NULL AND "status" = 'approved' AND "deleted_at" IS NULL;
