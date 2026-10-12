import {
  ALL_PERMISSION_KEYS,
  type PermissionAction,
  type PermissionModuleId,
} from "./registry";

/**
 * Admin NAV ↔ PAGE-GUARD parity — PURE (no DB, no session, no "server-only"),
 * so the client admin shell, the server pages and a unit test all read the SAME
 * grant lists.
 *
 * By default a sidebar item is visible with `<item id>:view` (the id is its
 * RBAC module). That breaks for a page whose guard is NOT `<id>:view`: the item
 * then shows a link that 404s (Caisse was shown to `orders:view` but needs
 * `orders:manage`), or hides a page the role can open (« Nouvelle commande »
 * also opens with `orders:manage`). Such an item carries an explicit
 * `visibleWhen` grant list, and its page gates with `requirePermissionAny` on
 * the SAME constant below — one list, so nav and guard cannot drift.
 */

export type PermissionGrant = {
  readonly module: PermissionModuleId;
  readonly action: PermissionAction;
};

/**
 * Who may OPEN « Nouvelle commande » (/admin/orders/new): its own tab grant OR
 * full order management. Mirrors the create action (orders_new:create OR
 * orders:manage — src/lib/actions/manual-order.ts). Without the OR, a role
 * granted orders:manage AFTER migration 0109 (which back-filled orders_new only
 * to roles that ALREADY held orders:manage) could place orders via the Caisse
 * but not open this page. Used by the page guard, the sidebar item and the
 * « Nouvelle commande » button on the Commandes list.
 */
export const ORDER_NEW_VIEW_GRANTS = [
  { module: "orders_new", action: "view" },
  { module: "orders", action: "manage" },
] as const satisfies readonly PermissionGrant[];

/**
 * Who may OPEN the Utilisateurs → Réglages page (/admin/users/settings): the
 * consolidated home for session policy + login/social-login configuration.
 * Reached by any of — a user administrator (`users:view`, via the Utilisateurs
 * subnav), a session-policy delegate (`users:policy`, the panel's own grant), or
 * a login/social-config operator (`system_auth:view`, via the Clients « Connexion
 * & comptes » shortcut) — so it gates on ANY. Each panel re-gates its own save
 * (session policy = users:policy, auth/social = system_auth:update) and is hidden
 * from an operator who can't use it. Used by the page guard AND the sidebar item's
 * visibleWhen (one list, no drift).
 */
export const USER_SETTINGS_VIEW_GRANTS = [
  { module: "users", action: "view" },
  { module: "users", action: "policy" },
  { module: "system_auth", action: "view" },
] as const satisfies readonly PermissionGrant[];

/**
 * Who may OPEN « Import data » (/admin/system/import-data): the merged
 * catalogue-import + bundled-bring-up tab (Contenu + Produits sub-tabs + the
 * super-admin purge). Reached by a catalogue importer (`system_import:view`,
 * the file/URL upload) OR a bring-up operator (`system_demo:view`, the bundled
 * content/catalog one-click). Each action re-gates its own run (upload =
 * system_import:manage, the bundled data-jobs = system_jobs:manage, the purge =
 * system_demo:manage + `*`). Used by the page guard AND the sidebar item's
 * visibleWhen (one list, no drift).
 */
export const IMPORT_DATA_VIEW_GRANTS = [
  { module: "system_import", action: "view" },
  { module: "system_demo", action: "view" },
] as const satisfies readonly PermissionGrant[];

/** OR over a grant list, given a `<module>:<action>` predicate (typically
 *  `permissionSetAllows` bound to an already-resolved permission set). */
export function allowsAnyGrant(
  can: (module: PermissionModuleId, action: PermissionAction) => boolean,
  grants: readonly PermissionGrant[],
): boolean {
  return grants.some((g) => can(g.module, g.action));
}

/**
 * Every concrete registry key (`<module>:<action>`, no wildcards) the predicate
 * allows — what the admin layout hands the client shell, so a `<module>:*` or
 * any other grant shape is already expanded and the shell only does set lookups.
 */
export function expandGrantedKeys(
  can: (module: PermissionModuleId, action: PermissionAction) => boolean,
): string[] {
  return ALL_PERMISSION_KEYS.filter((key) => {
    const idx = key.indexOf(":");
    return can(key.slice(0, idx) as PermissionModuleId, key.slice(idx + 1) as PermissionAction);
  });
}

/**
 * Is a sidebar item visible? `grantedKeys` null = the wildcard (every item).
 * An item with `visibleWhen` needs ANY of those grants; otherwise it needs
 * `<id>:view`.
 */
export function isNavItemVisible(
  item: { id: string; visibleWhen?: readonly PermissionGrant[] },
  grantedKeys: ReadonlySet<string> | null,
): boolean {
  if (grantedKeys === null) return true;
  if (item.visibleWhen) {
    return item.visibleWhen.some((g) => grantedKeys.has(`${g.module}:${g.action}`));
  }
  return grantedKeys.has(`${item.id}:view`);
}
