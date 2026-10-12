import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { id, timestamps } from "@/lib/db/columns";
import type { NavRootConfig } from "@/lib/cms/nav-composer-model";

/**
 * Navigation menus.
 *
 *   - `nav_menus` is the container (one row per logical menu: main, footer-shop,
 *     footer-support, footer-society, maison-explore) keyed by a stable `key`.
 *     The mobile header reuses the `main` menu — there is no separate `mobile` menu.
 *   - `nav_items` are the entries. Self-ref `parent_id` supports nesting.
 *
 * Items can either link to an internal route (`href`) or to a CMS-managed
 * resource (`internal_kind` + `internal_ref` e.g. category:femme, page:about).
 * The storefront resolves both transparently.
 */

export const nav_menus = pgTable(
  "nav_menus",
  {
    id: id(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    ...timestamps(),
  },
  (table) => ({
    keyUnique: uniqueIndex("nav_menus_key_unique").on(table.key),
  }),
);

export const nav_items = pgTable(
  "nav_items",
  {
    id: id(),
    menu_id: uuid("menu_id").notNull(),
    parent_id: uuid("parent_id"),
    label: text("label").notNull(),
    // Optional one-line sub-title under the label (migr 0176) — shown by the
    // « Explorer la maison » index (menu `maison-explore`); other menus ignore it.
    description: text("description"),
    href: text("href"),
    internal_kind: text("internal_kind"), // category | page | product | brand | system (see LinkKind in lib/links/link-target.ts)
    internal_ref: text("internal_ref"),
    icon: text("icon"),
    display_order: integer("display_order").notNull().default(0),
    is_visible: boolean("is_visible").notNull().default(true),
    open_in_new_tab: boolean("open_in_new_tab").notNull().default(false),
    // Composable mega-menu dropdown (migr 0180). NULL = a plain link (no dropdown).
    // Shape = NavRootConfig ({ dropdown: NavDropdown | null }); média ids inside
    // are tracked by navItemsConfigMediaMatch in all 3 media-reference seams.
    config: jsonb("config").$type<NavRootConfig>(),
    ...timestamps(),
  },
  (table) => ({
    menuIdx: index("nav_items_menu_idx").on(table.menu_id),
    // Visible-items-of-a-menu-in-order reads (the FOOTER columns + headless
    // `main` menu) are served by this partial covering index. (The storefront
    // HEADER resolver loads ALL items via nav_items_menu_idx — it needs hidden
    // rows to tell a materialized-but-all-hidden menu from an un-materialized one.)
    menuVisibleOrderIdx: index("nav_items_menu_visible_order_idx")
      .on(table.menu_id, table.display_order)
      .where(sql`${table.is_visible} = true`),
    parentOrderIdx: index("nav_items_parent_order_idx").on(table.parent_id, table.display_order),
  }),
);

export type NavMenuRow = typeof nav_menus.$inferSelect;
export type NavItemRow = typeof nav_items.$inferSelect;
export type NewNavMenuRow = typeof nav_menus.$inferInsert;
export type NewNavItemRow = typeof nav_items.$inferInsert;
