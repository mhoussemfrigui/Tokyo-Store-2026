-- 0129 — Drop the reserved-but-unwired `stock:manage` permission key.
--
-- `stock:manage` was reserved in the RBAC registry for a future transfers grant,
-- but the multi-location transfers op shipped gated on `stock:update` (a transfer
-- IS a stock write). The key therefore conferred nothing at authorization time,
-- and — like the keys purged in 0123 — a role holding it would fail the strict
-- role-editor schema on its next save ("Validation échouée") and be miscounted by
-- the escalation guards. Removed from the registry (stock is now view/update);
-- this drops any lingering grant. Idempotent (a plain DELETE).

DELETE FROM "role_permissions" WHERE "permission" = 'stock:manage';
