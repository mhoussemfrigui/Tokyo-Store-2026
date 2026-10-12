-- 0210 — Seed the storefront delivery backend (Commandes → Livraison).
--
-- The `pickup_locations` and `delivery_agents` tables ship EMPTY, so the PDP
-- "Retrait & livraison" section (and checkout pickup) had nothing real to read —
-- the PDP fell back to free-text contact addresses. This seeds the store's three
-- physical in-store pickup points plus one nationwide home-delivery carrier, so
-- the storefront reads them from the delivery backend the operator manages at
-- /admin/system/delivery (and they can be edited/disabled there).
--
-- Data-only + idempotent: each row inserts only when a row of the same name is
-- absent (id defaults to uuid_generate_v7(), so a bare re-apply would duplicate).
-- The operator can rename/move/disable any of these in the admin afterwards.

-- ── Points de retrait (in-store pickup, free) ─────────────────────────────────
INSERT INTO pickup_locations (name, kind, fee_cents, address_line, city, region, hours_label, enabled, display_order)
SELECT 'Lac 2 Mall Tunis', 'in_store', 0, 'Tunisia Mall, Les Berges du Lac 2', 'Tunis', 'Tunis', 'Lun–Sam · 9h–19h', true, 1
WHERE NOT EXISTS (SELECT 1 FROM pickup_locations WHERE name = 'Lac 2 Mall Tunis');

INSERT INTO pickup_locations (name, kind, fee_cents, address_line, city, region, hours_label, enabled, display_order)
SELECT 'Menzah 5', 'in_store', 0, 'Avenue Hédi Nouira, El Menzah 5', 'Tunis', 'Tunis', 'Lun–Sam · 9h–19h', true, 2
WHERE NOT EXISTS (SELECT 1 FROM pickup_locations WHERE name = 'Menzah 5');

INSERT INTO pickup_locations (name, kind, fee_cents, address_line, city, region, hours_label, enabled, display_order)
SELECT 'La Marsa', 'in_store', 0, 'Avenue Habib Bourguiba', 'La Marsa', 'Tunis', 'Lun–Sam · 9h–19h', true, 3
WHERE NOT EXISTS (SELECT 1 FROM pickup_locations WHERE name = 'La Marsa');

-- ── Transporteur (home delivery across Tunisia; fee inherits the global rate) ──
INSERT INTO delivery_agents (name, fee_cents, free_threshold_cents, zone_label, enabled, display_order)
SELECT 'Livraison à domicile', NULL, NULL, 'Partout en Tunisie', true, 1
WHERE NOT EXISTS (SELECT 1 FROM delivery_agents WHERE name = 'Livraison à domicile');
