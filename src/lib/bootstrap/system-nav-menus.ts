import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  FOOTER_COLUMN_DEFAULTS,
  MAISON_EXPLORE_DEFAULTS,
  MAISON_EXPLORE_MENU_KEY,
} from "@/lib/cms/nav-menus";

/**
 * Seed ONE system nav menu (+ its default items) if its key does not exist yet.
 * Idempotent and edit-safe:
 *   - the menu row is inserted `ON CONFLICT (key) DO NOTHING`;
 *   - the default items are inserted ONLY when that insert actually created the
 *     row — an existing menu (edited, reordered, or deliberately emptied by an
 *     admin) is never refilled.
 * Menu + items go in ONE transaction, so a crash mid-seed rolls the menu back too
 * (the next boot retries instead of finding a half-filled menu it would skip), and
 * concurrent boots are safe (the unique key makes the second insert return no row).
 * Returns the menu label when it seeded, else null.
 */
async function seedMenu(
  key: string,
  name: string,
  description: string | null,
  items: readonly { label: string; href: string; hint?: string | null }[],
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const inserted = (
      await tx.execute<{ id: string }>(sql`
        INSERT INTO nav_menus (key, name, description)
        VALUES (${key}, ${name}, ${description})
        ON CONFLICT (key) DO NOTHING
        RETURNING id
      `)
    ).rows[0];
    if (!inserted) return null;
    let order = 0;
    for (const item of items) {
      await tx.execute(sql`
        INSERT INTO nav_items (menu_id, label, description, href, display_order, is_visible, open_in_new_tab)
        VALUES (${inserted.id}, ${item.label}, ${item.hint ?? null}, ${item.href}, ${order++}, true, false)
      `);
    }
    return name;
  });
}

/**
 * Auto-deploy the system navigation menus that ship with built-in content:
 *   - the three footer link columns (`footer-shop` / `footer-support` /
 *     `footer-society`) rendered by the storefront footer, each seeded with the
 *     footer's built-in links so a fresh store shows the exact same columns while
 *     making every link editable in CMS → Footer; and
 *   - the « Explorer la maison » index (`maison-explore`) at the foot of the
 *     Maison & legal pages.
 *
 * Runs from `instrumentation.ts` on every boot — idempotent + never clobbers an
 * admin's edits (see {@link seedMenu}).
 */
export async function ensureSystemNavMenus(): Promise<void> {
  const seeded: string[] = [];
  for (const col of FOOTER_COLUMN_DEFAULTS) {
    const name = await seedMenu(col.key, col.title, `Colonne du pied de page.`, col.items);
    if (name) seeded.push(`${name} (${col.items.length})`);
  }
  const maison = await seedMenu(
    MAISON_EXPLORE_MENU_KEY,
    MAISON_EXPLORE_DEFAULTS.name,
    MAISON_EXPLORE_DEFAULTS.description,
    MAISON_EXPLORE_DEFAULTS.items.map((it) => ({ label: it.label, href: it.href, hint: it.hint })),
  );
  if (maison) seeded.push(`${maison} (${MAISON_EXPLORE_DEFAULTS.items.length})`);
  if (seeded.length) {
    console.log(`[system-nav] seeded system menus: ${seeded.join(", ")}.`);
  }
}
