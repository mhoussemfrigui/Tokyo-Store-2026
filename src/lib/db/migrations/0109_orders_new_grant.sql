-- 0109 — Back-fill the new `orders_new:*` grant (« Nouvelle commande » split off orders:manage)
--
-- Creating a REMOTE operator order (« Nouvelle commande » — téléphone / réseaux /
-- marketplace) used to require `orders:manage`, the SAME grant that edits / cancels
-- the online Commandes list. « Nouvelle commande » is now its OWN nav tab + registry
-- module (`orders_new`, actions view/create — src/lib/rbac/registry.ts) so an owner
-- can grant « peut créer une nouvelle commande » separately from full order
-- management (or the reverse).
--
-- To keep EVERY role that could create orders creating them after the split, grant
-- `orders_new:*` (covers view + create) to every role holding a LITERAL
-- `orders:manage` OR `orders:*` row. super_admin holds the global `*` (not a literal
-- orders row) so it is untouched — the wildcard already satisfies orders_new:*.
--
-- Idempotent: NOT EXISTS on (role_id, 'orders_new:*'). Permission keys are a CODE
-- registry (src/lib/rbac/registry.ts), not a table, so an unknown key is simply
-- ignored at authorization time.

INSERT INTO "role_permissions" ("role_id","permission")
  SELECT DISTINCT rp."role_id", 'orders_new:*'
  FROM "role_permissions" rp
  WHERE rp."permission" IN ('orders:manage', 'orders:*')
    AND NOT EXISTS (
      SELECT 1 FROM "role_permissions" x
      WHERE x."role_id" = rp."role_id" AND x."permission" = 'orders_new:*'
    );
