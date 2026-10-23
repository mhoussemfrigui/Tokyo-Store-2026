/**
 * One-off PATCH — repair the navigation after a content import.
 *
 * The content snapshot (public/demo-assets/tokyo-content.json) ships nav_menus +
 * nav_items, and the importer upserted the items BY ID on top of the
 * boot-materialized menus (the `main` header roots, the « Explorer la maison »
 * page index, and the footer columns). Boot + snapshot both seed the same
 * entries, so every menu ended up with each entry TWICE — a duplicated top nav
 * and a duplicated « Explorer la maison » / footer index. The snapshot also
 * carried a stale « Centre d'aide » → /aide link (the /aide help centre was
 * removed) and the footer was missing « Rendez-vous » + « Carrières ».
 *
 * This patch makes the navigation a FINISHED product in place — idempotent, so
 * it is safe to run on any store and to re-run:
 *   1. DEDUPLICATE nav_items — per menu, keep the EARLIEST of each identical
 *      (parent, label, href, internal target) entry; delete the rest.
 *   2. REMOVE every « /aide » link (the removed help centre).
 *   3. ADD « Carrières » (/carrieres) to the Société footer column and
 *      « Rendez-vous » (/rendez-vous) to the Support footer column, if missing.
 *
 * Run (local dev DB, from .env.local / .env.development.local):
 *   pnpm tsx --env-file-if-exists=.env.development.local scripts/patch-nav-fix.ts [--dry]
 * Run against a deployed store (point DATABASE_URL at it):
 *   DATABASE_URL="postgres://…" pnpm tsx scripts/patch-nav-fix.ts
 * `--dry` reports what it WOULD change and writes nothing.
 */
import { Pool } from "pg";

import { assertDestructiveTargetAllowed } from "./_safety-guard";

const DRY = process.argv.includes("--dry");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://tokyo:tokyo_dev_pwd@localhost:5434/tokyo",
});
const q = (t: string, p: unknown[] = []) => pool.query(t, p);

// Two nav_items are "the same entry" when they share menu, parent, label, href,
// and internal target. Tokyo's nav is flat (no parent/child rows today) but
// parent_id stays in the key for safety. Keep the EARLIEST (created_at, then id)
// — on a fresh import that is the boot-materialized row (clean default config),
// and the snapshot duplicate inserted later is the one removed.
const DEDUP_MATCH = `
  a.menu_id = b.menu_id
  AND coalesce(a.parent_id::text, '') = coalesce(b.parent_id::text, '')
  AND a.label = b.label
  AND coalesce(a.href, '') = coalesce(b.href, '')
  AND coalesce(a.internal_kind, '') = coalesce(b.internal_kind, '')
  AND coalesce(a.internal_ref, '') = coalesce(b.internal_ref, '')
`;
const EARLIER_B = `(b.created_at < a.created_at OR (b.created_at = a.created_at AND b.id < a.id))`;

async function ensureFooterLink(menuKey: string, label: string, href: string): Promise<void> {
  const menu = (await q(`SELECT id FROM nav_menus WHERE key = $1 LIMIT 1`, [menuKey])).rows[0] as
    | { id: string }
    | undefined;
  if (!menu) {
    console.log(`[nav-patch] footer menu « ${menuKey} » missing — skipped ${href}`);
    return;
  }
  const exists = (
    await q(`SELECT 1 FROM nav_items WHERE menu_id = $1 AND href = $2 LIMIT 1`, [menu.id, href])
  ).rows[0];
  if (exists) {
    console.log(`[nav-patch] « ${label} » already in ${menuKey} — ok.`);
    return;
  }
  const nextOrder = Number(
    (
      await q(`SELECT coalesce(max(display_order), -1) + 1 AS n FROM nav_items WHERE menu_id = $1`, [
        menu.id,
      ])
    ).rows[0].n,
  );
  if (!DRY) {
    await q(
      `INSERT INTO nav_items (menu_id, label, href, display_order, is_visible, open_in_new_tab)
       VALUES ($1, $2, $3, $4, true, false)`,
      [menu.id, label, href, nextOrder],
    );
  }
  console.log(`[nav-patch]   ${DRY ? "would add" : "added"} « ${label} » → ${href} to ${menuKey}.`);
}

async function main() {
  assertDestructiveTargetAllowed(process.env.DATABASE_URL, "DELETE nav_items (dedup + /aide removal)");
  // ── 1. Deduplicate nav_items ───────────────────────────────────────────────
  const dupCount = Number(
    (
      await q(`
        SELECT count(*)::int AS n FROM nav_items a
        WHERE EXISTS (SELECT 1 FROM nav_items b WHERE ${DEDUP_MATCH} AND ${EARLIER_B})
      `)
    ).rows[0].n,
  );
  console.log(`[nav-patch] duplicate nav items: ${dupCount}`);
  if (!DRY && dupCount > 0) {
    await q(`DELETE FROM nav_items a USING nav_items b WHERE ${DEDUP_MATCH} AND ${EARLIER_B}`);
    console.log(`[nav-patch]   removed ${dupCount} duplicate item(s).`);
  }

  // ── 2. Remove the stale « /aide » help-centre links ────────────────────────
  const aideCount = Number(
    (await q(`SELECT count(*)::int AS n FROM nav_items WHERE href = '/aide'`)).rows[0].n,
  );
  console.log(`[nav-patch] « /aide » links: ${aideCount}`);
  if (!DRY && aideCount > 0) {
    await q(`DELETE FROM nav_items WHERE href = '/aide'`);
    console.log(`[nav-patch]   removed ${aideCount} « /aide » link(s).`);
  }

  // ── 3. Ensure the two requested footer links exist ─────────────────────────
  await ensureFooterLink("footer-society", "Carrières", "/carrieres");
  await ensureFooterLink("footer-support", "Rendez-vous", "/rendez-vous");

  console.log(DRY ? "[nav-patch] DRY RUN — nothing written." : "[nav-patch] done.");
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    console.error("[nav-patch] failed:", err);
    await pool.end();
    process.exit(1);
  });
