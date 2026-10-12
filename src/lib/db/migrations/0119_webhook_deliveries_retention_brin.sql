-- 0119 — webhook_deliveries retention-purge index.
--
-- The daily retention sweep (webhookEndpointService.purgeOlderThan → the
-- `webhook_deliveries` retention window) deletes `WHERE created_at < cutoff`. The
-- existing indexes lead with `status` / `endpoint_id`, so none serves a bare
-- created_at range → the purge was a full seq scan that grows with the (high-
-- volume, fan-out) delivery log.
--
-- BRIN, not btree: deliveries are INSERTed in created_at order (an append-only
-- log), so a block-range index is a near-perfect fit — a few KB with negligible
-- INSERT overhead on the hot enqueue path, while still turning the purge's
-- created_at range scan into a block-range skip. A btree would bloat the table
-- and tax every insert for no read benefit the drain needs.
--
-- Additive-only + idempotent.

CREATE INDEX IF NOT EXISTS "webhook_deliveries_created_at_brin"
  ON "webhook_deliveries" USING brin ("created_at");
