import "server-only";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  nav_items,
  nav_menus,
  type NavItemRow,
  type NavMenuRow,
  type NewNavItemRow,
  type NewNavMenuRow,
} from "./schema";

class NavigationService {
  async findMenuByKey(key: string): Promise<NavMenuRow | null> {
    const [row] = await db.select().from(nav_menus).where(eq(nav_menus.key, key)).limit(1);
    return row ?? null;
  }
  async listMenus() {
    return db.select().from(nav_menus).orderBy(asc(nav_menus.key));
  }
  async insertMenu(input: NewNavMenuRow): Promise<NavMenuRow> {
    const [row] = await db.insert(nav_menus).values(input).returning();
    return row;
  }
  /** Edit a menu's display name / description. The `key` is intentionally NOT
   *  patchable here — it's the stable lookup the storefront reads. */
  async updateMenu(
    id: string,
    patch: Partial<Pick<NavMenuRow, "name" | "description">>,
  ): Promise<NavMenuRow | null> {
    const [row] = await db
      .update(nav_menus)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(nav_menus.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Returns ALL items for a menu (visible + hidden). Used by the admin UI AND by
   * the storefront header resolver (`getComposedNavRoots`), which needs the hidden
   * rows too: a MATERIALIZED menu with every root hidden must render an empty
   * header, told apart from a never-materialized menu (0 rows → default roots).
   * The footer path still uses `listVisibleItemsForMenu` (visible-only).
   */
  async listAllItemsForMenu(menuId: string): Promise<NavItemRow[]> {
    return db
      .select()
      .from(nav_items)
      .where(eq(nav_items.menu_id, menuId))
      .orderBy(asc(nav_items.display_order));
  }

  /**
   * Batch variant of `listAllItemsForMenu`: fetch items for many menus in a
   * single query and group them by `menu_id` in JS. Used by the admin
   * navigation page to avoid the N+1 of running one query per menu.
   * Returns a Map keyed by menu id; menus with zero items get an empty array.
   */
  async listItemsForMenus(menuIds: string[]): Promise<Map<string, NavItemRow[]>> {
    const grouped = new Map<string, NavItemRow[]>();
    for (const id of menuIds) grouped.set(id, []);
    if (menuIds.length === 0) return grouped;
    const rows = await db
      .select()
      .from(nav_items)
      .where(inArray(nav_items.menu_id, menuIds))
      .orderBy(asc(nav_items.display_order));
    for (const row of rows) {
      const bucket = grouped.get(row.menu_id);
      if (bucket) bucket.push(row);
      else grouped.set(row.menu_id, [row]);
    }
    return grouped;
  }

  /**
   * Storefront-facing items list — only visible rows.
   */
  async listVisibleItemsForMenu(menuId: string): Promise<NavItemRow[]> {
    return db
      .select()
      .from(nav_items)
      .where(and(eq(nav_items.menu_id, menuId), eq(nav_items.is_visible, true)))
      .orderBy(asc(nav_items.display_order));
  }

  /**
   * @deprecated alias of `listVisibleItemsForMenu`. Kept so existing
   * storefront code (`queries.ts:getMenu`) compiles; new code should pick
   * one of the two explicit methods above.
   */
  async listItemsForMenu(menuId: string): Promise<NavItemRow[]> {
    return this.listVisibleItemsForMenu(menuId);
  }

  async findItemById(id: string): Promise<NavItemRow | null> {
    const [row] = await db.select().from(nav_items).where(eq(nav_items.id, id)).limit(1);
    return row ?? null;
  }

  async insertItem(input: NewNavItemRow): Promise<NavItemRow> {
    const [row] = await db.insert(nav_items).values(input).returning();
    return row;
  }

  async updateItem(id: string, patch: Partial<Omit<NavItemRow, "id" | "created_at">>) {
    const [row] = await db
      .update(nav_items)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(nav_items.id, id))
      .returning();
    return row ?? null;
  }

  async deleteItem(id: string) {
    await db.delete(nav_items).where(eq(nav_items.id, id));
  }

  /**
   * Every nav menu id. Used by the segmented `clean` flow to wipe ALL menus
   * (not just the demo-keyed set). Pair with `deleteItemsByMenuIds` +
   * `deleteMenusByIds` to remove the items first, then the menus.
   */
  async listAllMenuIds(): Promise<string[]> {
    const rows = await db.select({ id: nav_menus.id }).from(nav_menus);
    return rows.map((r) => r.id);
  }

  /**
   * Hard-delete every nav item whose menu_id is in the given set. Returns
   * the deleted item ids so callers can report counts. Pair with
   * `deleteMenusByIds` to clean up an entire menu in two queries.
   */
  async deleteItemsByMenuIds(menuIds: string[]): Promise<string[]> {
    if (menuIds.length === 0) return [];
    const rows = await db
      .delete(nav_items)
      .where(inArray(nav_items.menu_id, menuIds))
      .returning({ id: nav_items.id });
    return rows.map((r) => r.id);
  }

  /**
   * Hard-delete menus by id. Caller should remove the menu's items first
   * (via `deleteItemsByMenuIds`) — this method only owns the menu rows.
   */
  async deleteMenusByIds(menuIds: string[]): Promise<string[]> {
    if (menuIds.length === 0) return [];
    const rows = await db
      .delete(nav_menus)
      .where(inArray(nav_menus.id, menuIds))
      .returning({ id: nav_menus.id });
    return rows.map((r) => r.id);
  }
}

export const navigationService = new NavigationService();
