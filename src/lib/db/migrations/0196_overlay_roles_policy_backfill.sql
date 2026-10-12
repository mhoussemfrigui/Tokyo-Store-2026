-- 0196 — Complete the users:manage → users:roles + users:policy back-fill for the
-- per-user OVERLAY (0194 covered role grants only). A rare account that holds an
-- ALLOW override of `users:manage` directly (not via a role) would otherwise lose
-- the grant-power + session-policy capability once the code moved those actions
-- onto the new verbs. Mirror the role back-fill onto user_permissions.
--
-- Idempotent via NOT EXISTS on each (user_id, permission). Only ALLOW overrides of
-- users:manage are widened (a DENY of users:manage is a restriction, not a grant).
INSERT INTO "user_permissions" ("user_id", "permission", "effect")
SELECT up."user_id", v.perm, 'allow'
FROM "user_permissions" up
CROSS JOIN (VALUES ('users:roles'), ('users:policy')) AS v(perm)
WHERE up."permission" = 'users:manage'
  AND up."effect" = 'allow'
  AND NOT EXISTS (
    SELECT 1 FROM "user_permissions" x
    WHERE x."user_id" = up."user_id" AND x."permission" = v.perm
  );
