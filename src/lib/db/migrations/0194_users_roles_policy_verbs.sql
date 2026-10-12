-- 0194 — Split the `users:manage` grant into finer verbs: back-fill `users:roles`
-- (the privilege-GRANT power: assign roles, author/edit/delete roles, set a
-- per-user allow/deny overlay) and `users:policy` (the shop-wide session policy)
-- onto every role that currently holds the concrete `users:manage` key, so no
-- existing operator loses a capability when the code moves those actions onto the
-- new slices. Routine account ops stay on `users:manage`.
--
-- Only CONCRETE `users:manage` holders need the back-fill: a role holding the
-- module wildcard `users:*` already covers `users:roles`/`users:policy`, and
-- `super_admin` holds the global `*` — neither needs a row. Idempotent via
-- NOT EXISTS on each (role_id, permission).
INSERT INTO "role_permissions" ("role_id", "permission")
SELECT rp."role_id", v.perm
FROM "role_permissions" rp
CROSS JOIN (VALUES ('users:roles'), ('users:policy')) AS v(perm)
WHERE rp."permission" = 'users:manage'
  AND NOT EXISTS (
    SELECT 1 FROM "role_permissions" x
    WHERE x."role_id" = rp."role_id" AND x."permission" = v.perm
  );
