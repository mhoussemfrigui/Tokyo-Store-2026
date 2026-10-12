import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { asBool } from "@/lib/cms/setting-coerce";
import { MAIN_NAV_MENU_KEY } from "@/lib/cms/nav-menus";
import { defaultNavRoots } from "@/lib/cms/nav-defaults";
import { serializeNavConfig } from "@/lib/cms/nav-composer-model";

/**
 * MATERIALIZE the default crimson header nav — the « Catégories » universes, the
 * centre shortcut pills and the mobile « Service client » links — into the
 * editable `main` menu as `nav_items` with a composable `config`, so the whole
 * header becomes operator-editable (Contenu & Design → Menu de navigation) and
 * the storefront reads it from the DB.
 *
 * VERSIONED + idempotent + concurrency-safe: a `nav.header.materialized.v2`
 * settings flag is the lock. The instance whose `INSERT … ON CONFLICT DO NOTHING`
 * creates it does the (re)seed; everyone else (and every later boot) is a no-op,
 * so an admin's later edits are never clobbered. The `.v2` bump re-seeds the new
 * universe structure over the previous Boutique/Marques/Maison roots on deploy
 * (this is the intentional nav redesign) — each store does it once.
 *
 * A universe root is a CATEGORY link (`internal_kind`/`internal_ref`), so its
 * `taxonomy` + `products` blocks auto-resolve that universe's sub-categories and
 * products from the live catalog. No banner/imagery is baked in — operators add a
 * per-universe image block in the builder (multi-size + recommended dimensions).
 */
const FLAG_KEY = "nav.header.materialized.v2";

export async function ensureHeaderNavRoots(): Promise<void> {
  const settings = await getSettingsMap().catch(() => ({}) as Record<string, string | null>);
  if (asBool(settings[FLAG_KEY], false)) return; // already materialized — fast path

  // Build the default roots with any existing label overrides.
  const roots = defaultNavRoots({
    label: (key, fallback) => settings[key]?.trim() || fallback,
  });

  const seeded = await db.transaction(async (tx) => {
    // The flag insert is the lock: only the winner materializes.
    const flag = (
      await tx.execute<{ key: string }>(sql`
        INSERT INTO site_settings (key, value, type, group_key, label)
        VALUES (${FLAG_KEY}, 'true', 'boolean', 'nav', 'Nav header matérialisé (v2)')
        ON CONFLICT (key) DO NOTHING
        RETURNING key
      `)
    ).rows[0];
    if (!flag) return false; // another instance already did it

    // Ensure the `main` menu exists, then grab its id.
    await tx.execute(sql`
      INSERT INTO nav_menus (key, name, description)
      VALUES (${MAIN_NAV_MENU_KEY}, 'Menu principal', 'En-tête du site')
      ON CONFLICT (key) DO NOTHING
    `);
    const menu = (
      await tx.execute<{ id: string }>(sql`SELECT id FROM nav_menus WHERE key = ${MAIN_NAV_MENU_KEY} LIMIT 1`)
    ).rows[0];
    if (!menu) return false;

    // v2 is a STRUCTURAL re-seed (universes replace the old 3 roots): clear the
    // header's top-level items first. Tokyo's header nav is flat (dropdowns live
    // in `config`, no child rows), so this only drops the old header roots — the
    // separate footer menus are untouched. The .v2 flag (set above) means later
    // boots fast-path out, so admin edits to the new nav are never re-clobbered.
    await tx.execute(sql`DELETE FROM nav_items WHERE menu_id = ${menu.id}::uuid AND parent_id IS NULL`);

    let order = 0;
    for (const r of roots) {
      const isInternal = Boolean(r.kind && r.ref);
      const href = isInternal ? null : r.href;
      const kind = isInternal ? r.kind : null;
      const ref = isInternal ? r.ref : null;
      const config = JSON.stringify(
        serializeNavConfig(r.dropdown, { slot: r.slot, blurb: r.blurb, accent: r.accent }),
      );
      await tx.execute(sql`
        INSERT INTO nav_items (menu_id, label, href, internal_kind, internal_ref, icon, display_order, is_visible, open_in_new_tab, config)
        VALUES (${menu.id}::uuid, ${r.label}, ${href}, ${kind}, ${ref}, ${r.icon}, ${order++}, true, false, ${config}::jsonb)
      `);
    }
    return true;
  });
  if (seeded) {
    console.log(`[system-nav] materialized ${roots.length} header roots (universes + shortcuts + service) into the editable \`main\` menu.`);
  }
}
