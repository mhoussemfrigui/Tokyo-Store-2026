-- 0121 — Remove the serial-number subsystem.
--
-- Drops the per-product `requires_serial` flag and the `order_item_serials`
-- ledger (serial capture at fulfilment + warranty-by-serial lookup). The product
-- form no longer exposes the toggle, the order ship-gate no longer requires a
-- serial per unit, and the SAV/warranty lookup now searches by order number or
-- customer phone.
--
-- KEPT (unaffected): warranty DURATION — `products.warranty_months` /
-- `warranty_label` (and the category cascade), snapshotted onto `order_items`
-- at checkout and shown on the PDP / invoice / warranty verdict.
--
-- Destructive but intended: any recorded serials are discarded. Idempotent.

DROP TABLE IF EXISTS "order_item_serials";
--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN IF EXISTS "requires_serial";
