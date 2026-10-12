-- Remove the announcement bar ("Bandeau d'annonce") feature entirely. It was
-- unused (0 active announcements) and redundant with the `header_strip` banner
-- placement ("Bandeau header"), which the storefront top strip now renders.
-- Drops the table (cols: message/href/link_label/bg_color/text_color/
-- is_dismissible/is_active/display_order/starts_at/ends_at + timestamps; indexes
-- announcements_order_idx / _active_idx / _schedule_idx) and purges every
-- leftover RBAC permission row for the removed module.
DROP TABLE IF EXISTS "announcements" CASCADE;--> statement-breakpoint
DELETE FROM "role_permissions" WHERE "permission" LIKE 'announcements:%';
