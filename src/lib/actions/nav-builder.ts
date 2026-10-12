"use server";

import { revalidatePath } from "next/cache";
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { nav_items, nav_menus } from "@/modules/cms/navigation/schema";
import { requirePermission } from "@/lib/auth/session";
import { bus } from "@/events/bus";
import { MAIN_NAV_MENU_KEY } from "@/lib/cms/nav-menus";
import { safeHref } from "@/lib/utils/safe-href";
import { LINK_KINDS } from "@/lib/links/link-target";
import {
  parseNavDropdown,
  serializeNavConfig,
  NAV_SLOTS,
  DEFAULT_NAV_SLOT,
  type NavSlot,
} from "@/lib/cms/nav-composer-model";
import { type ActionState } from "@/lib/actions/types";

/** The editable root shape the nav builder serializes (one JSON blob). */
type EditableRoot = {
  label?: unknown;
  linkKind?: unknown;
  linkValue?: unknown;
  icon?: unknown;
  isVisible?: unknown;
  newTab?: unknown;
  dropdown?: unknown;
  /** Header placement + per-slot extras (universe blurb / shortcut accent). */
  slot?: unknown;
  blurb?: unknown;
  accent?: unknown;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Replace-all save of the HEADER nav (the `main` menu's top-level roots + each
 * root's composable dropdown `config`). The builder owns the whole structure, so
 * this deletes every current `main` item and re-inserts the roots in order —
 * clean because the roots carry no external id references (liveness/redirects key
 * on kind+ref, not nav_item ids). An empty save leaves the menu empty, and the
 * storefront resolver then falls back to the default roots.
 */
export async function saveHeaderNavAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("navigation", "update");

  let roots: EditableRoot[];
  try {
    const raw = JSON.parse(String(formData.get("nav") ?? "[]"));
    roots = Array.isArray(raw) ? (raw as EditableRoot[]) : [];
  } catch {
    return { ok: false, error: "validation", message: "Données du menu invalides." };
  }

  // Normalize each root → a nav_items row shape. A root needs a label.
  const rows = roots
    .map((r) => {
      const label = str(r.label).trim();
      if (!label) return null;
      const kind = str(r.linkKind).trim();
      const value = str(r.linkValue).trim();
      const isUrl = kind === "" || kind === "url" || !(LINK_KINDS as readonly string[]).includes(kind);
      const dropdown = parseNavDropdown(
        (r.dropdown ?? null) as Record<string, unknown> | null,
      );
      const slotRaw = str(r.slot).trim();
      const slot: NavSlot = (NAV_SLOTS as readonly string[]).includes(slotRaw)
        ? (slotRaw as NavSlot)
        : DEFAULT_NAV_SLOT;
      const blurb = str(r.blurb).trim() || null;
      const accent = r.accent === true;
      // An empty / invalid URL becomes a NULL target (not a dead "#" link): a
      // root with no usable link is kept only as a dropdown trigger, which the
      // header renders as a button rather than a link to nowhere.
      const safe = isUrl && value ? safeHref(value) : null;
      return {
        label: label.slice(0, 120),
        href: isUrl ? (safe && safe !== "#" ? safe : null) : null,
        internal_kind: isUrl ? null : kind,
        internal_ref: isUrl ? null : value || null,
        icon: str(r.icon).trim() || null,
        is_visible: r.isVisible !== false,
        open_in_new_tab: r.newTab === true,
        // Store `config` whenever the root carries a dropdown OR a non-default
        // placement/extra (a shortcut pill, a mobile service link, a universe
        // blurb, a crimson accent). A plain `mega` link with nothing extra keeps
        // a SQL NULL config (the schema contract: NULL = no dropdown).
        config:
          dropdown || slot !== DEFAULT_NAV_SLOT || blurb || accent
            ? serializeNavConfig(dropdown, { slot, blurb, accent })
            : null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  let savedMenuId: string | null = null;
  await db.transaction(async (tx) => {
    // Ensure the `main` menu exists, then grab its id.
    await tx.execute(sql`
      INSERT INTO nav_menus (key, name, description)
      VALUES (${MAIN_NAV_MENU_KEY}, 'Menu principal', 'En-tête du site')
      ON CONFLICT (key) DO NOTHING
    `);
    const [menu] = await tx
      .select({ id: nav_menus.id })
      .from(nav_menus)
      .where(eq(nav_menus.key, MAIN_NAV_MENU_KEY))
      .limit(1);
    if (!menu) return;
    await tx.delete(nav_items).where(eq(nav_items.menu_id, menu.id));
    if (rows.length > 0) {
      await tx.insert(nav_items).values(
        rows.map((r, i) => ({ ...r, menu_id: menu.id, display_order: i })),
      );
    }
    // Mark the header materialized (v2 — the universe structure) so the boot seed
    // (ensureHeaderNavRoots) never re-seeds over these admin-saved roots — even if
    // its first-boot run failed before setting the flag itself.
    await tx.execute(sql`
      INSERT INTO site_settings (key, value, type, group_key, label)
      VALUES ('nav.header.materialized.v2', 'true', 'boolean', 'nav', 'Nav header matérialisé (v2)')
      ON CONFLICT (key) DO UPDATE SET value = 'true'
    `);
    savedMenuId = menu.id;
  });

  // The `main` menu is bootstrapped on boot and self-healed above, so this is
  // effectively unreachable — but never claim success if nothing was written.
  if (!savedMenuId) {
    return { ok: false, error: "server", message: "Menu introuvable." };
  }

  // Audit + cache-bust AFTER the commit (keeps the write transaction short and
  // never busts caches for a change that rolled back).
  await bus.emit(
    "nav.menu.updated",
    { menuId: savedMenuId, key: MAIN_NAV_MENU_KEY },
    { actorUserId: session.user.id },
  );
  // Storefront header reads the nav per request under the (shop) layout; nav
  // reads are not cached, so the layout revalidate is what refreshes it.
  revalidatePath("/", "layout");
  revalidatePath("/admin/cms/nav-menu");
  return { ok: true, message: "Menu enregistré." };
}

export type NavRepairResult =
  | { ok: true; deduped: number; aideRemoved: number; footerAdded: string[]; message: string }
  | { ok: false; message: string };

// Two nav_items are "the same entry" when they share menu, parent, label, href
// and internal target. Tokyo's nav is flat (dropdowns live in `config`, no
// parent/child rows), so this never collapses a legitimate sub-item. Keep the
// EARLIEST (created_at, then id) — the boot-materialized row with its clean
// default config — and drop the import's later duplicate.
const NAV_DEDUP_MATCH = `
  a.menu_id = b.menu_id
  AND coalesce(a.parent_id::text, '') = coalesce(b.parent_id::text, '')
  AND a.label = b.label
  AND coalesce(a.href, '') = coalesce(b.href, '')
  AND coalesce(a.internal_kind, '') = coalesce(b.internal_kind, '')
  AND coalesce(a.internal_ref, '') = coalesce(b.internal_ref, '')
`;
const NAV_EARLIER_B = `(b.created_at < a.created_at OR (b.created_at = a.created_at AND b.id < a.id))`;

/** Insert a footer link if it's missing; returns true only when a row was added. */
async function ensureFooterLinkRow(menuKey: string, label: string, href: string): Promise<boolean> {
  const menu = (
    await db.$client.query<{ id: string }>(`SELECT id FROM nav_menus WHERE key = $1 LIMIT 1`, [
      menuKey,
    ])
  ).rows[0];
  if (!menu) return false; // menu not seeded on this store — nothing to attach to.
  const exists = (
    await db.$client.query(`SELECT 1 FROM nav_items WHERE menu_id = $1 AND href = $2 LIMIT 1`, [
      menu.id,
      href,
    ])
  ).rows[0];
  if (exists) return false;
  const nextOrder = Number(
    (
      await db.$client.query<{ n: number }>(
        `SELECT coalesce(max(display_order), -1) + 1 AS n FROM nav_items WHERE menu_id = $1`,
        [menu.id],
      )
    ).rows[0]?.n ?? 0,
  );
  await db.$client.query(
    `INSERT INTO nav_items (menu_id, label, href, display_order, is_visible, open_in_new_tab)
     VALUES ($1, $2, $3, $4, true, false)`,
    [menu.id, label, href, nextOrder],
  );
  return true;
}

/**
 * Repair the navigation after a content import — the UI twin of
 * `scripts/patch-nav-fix.ts`, idempotent and safe to re-run. The content
 * snapshot's nav_items were historically upserted on top of the boot-seeded
 * menus, so a store imported before the `segments.ts` fix carries a doubled top
 * nav, « Explorer la maison » index and footer. This:
 *   1. de-duplicates nav_items (keep the earliest per menu+label+target),
 *   2. removes the stale « /aide » help-centre links (the /aide centre is gone),
 *   3. ensures « Recrutement » (Société) in the footer.
 * Gated by `navigation:update`, re-checked here regardless of the page gate.
 */
export async function repairNavigationAction(): Promise<NavRepairResult> {
  const session = await requirePermission("navigation", "update");

  try {
    // 1. Deduplicate nav_items.
    const deduped = Number(
      (
        await db.$client.query<{ n: number }>(`
          SELECT count(*)::int AS n FROM nav_items a
          WHERE EXISTS (SELECT 1 FROM nav_items b WHERE ${NAV_DEDUP_MATCH} AND ${NAV_EARLIER_B})
        `)
      ).rows[0]?.n ?? 0,
    );
    if (deduped > 0) {
      await db.$client.query(
        `DELETE FROM nav_items a USING nav_items b WHERE ${NAV_DEDUP_MATCH} AND ${NAV_EARLIER_B}`,
      );
    }

    // 2. Remove the stale « /aide » links.
    const aideRemoved = Number(
      (await db.$client.query<{ n: number }>(`SELECT count(*)::int AS n FROM nav_items WHERE href = '/aide'`))
        .rows[0]?.n ?? 0,
    );
    if (aideRemoved > 0) {
      await db.$client.query(`DELETE FROM nav_items WHERE href = '/aide'`);
    }

    // 3. Ensure the requested footer link exists.
    const footerAdded: string[] = [];
    if (await ensureFooterLinkRow("footer-society", "Recrutement", "/recrutement")) {
      footerAdded.push("Recrutement");
    }

    // Audit + cache-bust. The storefront reads nav per request under the (shop)
    // layout (uncached), so the layout revalidate is what refreshes the header,
    // « Explorer la maison » index and footer.
    const main = (
      await db.$client.query<{ id: string }>(`SELECT id FROM nav_menus WHERE key = $1 LIMIT 1`, [
        MAIN_NAV_MENU_KEY,
      ])
    ).rows[0];
    if (main) {
      await bus.emit(
        "nav.menu.updated",
        { menuId: main.id, key: MAIN_NAV_MENU_KEY },
        { actorUserId: session.user.id },
      );
    }
    revalidatePath("/", "layout");
    revalidatePath("/admin/cms/nav-menu");

    const parts = [deduped > 0 ? `${deduped} doublon(s) supprimé(s)` : "aucun doublon"];
    if (aideRemoved > 0) parts.push(`${aideRemoved} lien « /aide » retiré`);
    if (footerAdded.length > 0) parts.push(`${footerAdded.join(" + ")} ajouté(s) au pied de page`);
    const nothingToDo = deduped === 0 && aideRemoved === 0 && footerAdded.length === 0;

    return {
      ok: true,
      deduped,
      aideRemoved,
      footerAdded,
      message: nothingToDo
        ? "Navigation déjà saine — rien à réparer."
        : `Navigation réparée : ${parts.join(", ")}.`,
    };
  } catch {
    return { ok: false, message: "La réparation a échoué — réessayez." };
  }
}
