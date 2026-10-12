-- 0181 — prune dead/redundant CMS indexes (stability / write-overhead; no read regression).
--
-- site_settings: no query filters or orders by group_key (getSettingsMap reads the
-- whole table; every panel narrows by key PREFIX via pickSettings), so both group
-- indexes are pure write overhead:
--   * settings_group_idx            — group_key alone, unused.
--   * site_settings_group_order_idx — (group_key, display_order); ALSO schema-drift,
--                                     no longer declared in the drizzle schema.
-- nav_items: the item lists are always menu-scoped (WHERE menu_id … ORDER BY
-- display_order), served by nav_items_menu_idx + the partial
-- nav_items_menu_visible_order_idx; nothing queries display_order globally, and
-- parent_id is only used for the self-cascade (covered by the parent_order_idx
-- prefix). Two more are redundant:
--   * nav_items_order_idx   — display_order alone, never used without a menu scope.
--   * nav_items_parent_idx  — parent_id alone, redundant with nav_items_parent_order_idx.
-- Kept: all pkeys, settings_key_unique, nav menu / menu_visible_order / parent_order.
-- Mirrors 0178's banner-index prune.
DROP INDEX IF EXISTS "settings_group_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "site_settings_group_order_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "nav_items_order_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "nav_items_parent_idx";
