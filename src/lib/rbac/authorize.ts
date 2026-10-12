import "server-only";

import { cache } from "react";

import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { allowsAnyGrant, expandGrantedKeys, type PermissionGrant } from "./nav-access";
import { applyPermissionOverlay } from "./overlay";
import { accountTypeFromPerms, type AccountType } from "./account-type";
import {
  WILDCARD,
  type PermissionAction,
  type PermissionModuleId,
} from "./registry";

/**
 * Authorization ENGINE — resolves a user's effective permission set and answers
 * "may this user do <module>:<action>?". Deals only in userId; it does NOT
 * touch sessions or Next.js routing, so it's reusable by the session gates
 * (`requirePermission` in `src/lib/auth/session.ts`), by admin nav-visibility,
 * and later by the API-key actor. The routing-aware gates layer on top.
 *
 * Request-scoped memo via React `cache()`: `requirePermission`'s internal call,
 * each admin page's secondary `resolveUserPermissions`, and the admin shell's
 * resolution all collapse to ONE DB hit per (request, userId). Still live across
 * requests — revoking a role or disabling a user takes effect on the next one.
 */

/**
 * Effective permission keys for a user, as a Set (may contain "*" and
 * "<module>:*" wildcards — interpret via `permissionSetAllows`, don't compare
 * raw).
 *
 * Effective set = union(role grants) ∪ allow − deny (the per-user OVERLAY, 0191):
 * a role is a baseline template, the overlay adds/removes specific actions for one
 * account (deny wins; wildcard materialized only when a deny exists — see
 * `src/lib/rbac/overlay.ts`). ~99% of users have no overrides → the fast path.
 *
 * Access is ROLE-ONLY: `'*'` (super-admin) comes solely from a role grant (the
 * `super_admin` role), never a stored account-type — the legacy `users.role` enum +
 * its `admin → '*'` bridge were retired (migration 0192 backfilled the role onto
 * every enum admin first). A disabled account resolves to the empty set — denied
 * everywhere.
 */
export const resolveUserPermissions = cache(
  async (userId: string): Promise<Set<string>> => {
    const row = await authService.findById(userId);
    if (!row || row.disabledAt) return new Set();
    const [roleGrants, overrides] = await Promise.all([
      rbacService.listPermissionsForUser(userId),
      rbacService.listUserPermissionOverrides(userId),
    ]);
    return applyPermissionOverlay(roleGrants, overrides);
  },
);

/**
 * The user's DERIVED account type (Client / Staff / Admin) — a label only;
 * authorization never consults it. Derived from `roles ∪ allow` overrides (NOT the
 * deny-subtracted effective set): a per-user deny is a fine-grained restriction,
 * not a demotion (a "Vendeur" minus one action is still staff), and deriving from
 * the deny-subtracted set could materialize a super-admin's `*` away and mislabel
 * them. Request-memoized; independent of `disabledAt` (a disabled admin is still
 * an admin — status is shown separately).
 */
export const resolveAccountType = cache(async (userId: string): Promise<AccountType> => {
  const row = await authService.findById(userId);
  if (!row) return "customer";
  const [roleGrants, overrides] = await Promise.all([
    rbacService.listPermissionsForUser(userId),
    rbacService.listUserPermissionOverrides(userId),
  ]);
  const allowSet = new Set<string>([
    ...roleGrants,
    ...overrides.filter((o) => o.effect !== "deny").map((o) => o.permission),
  ]);
  return accountTypeFromPerms(allowSet);
});

/**
 * Does an already-resolved permission set allow `<module>:<action>`? Honours
 * the global wildcard ("*") and the per-module wildcard ("<module>:*").
 * Synchronous so a caller that resolved the set once can check many actions
 * (e.g. building the visible nav) without re-querying.
 */
export function permissionSetAllows(
  perms: Set<string>,
  module: PermissionModuleId,
  action: PermissionAction,
): boolean {
  if (perms.has(WILDCARD)) return true;
  if (perms.has(`${module}:*`)) return true;
  return perms.has(`${module}:${action}`);
}

/**
 * OR form of {@link permissionSetAllows} — does the set allow ANY of `grants`?
 * The synchronous twin of `requirePermissionAny`, for UI that must follow the
 * same OR as a page guard (e.g. the « Nouvelle commande » button ↔
 * ORDER_NEW_VIEW_GRANTS in src/lib/rbac/nav-access.ts).
 */
export function permissionSetAllowsAny(
  perms: Set<string>,
  grants: readonly PermissionGrant[],
): boolean {
  return allowsAnyGrant((m, a) => permissionSetAllows(perms, m, a), grants);
}

/** Whether a user may enter the admin area at all (the `/admin` shell gate):
 *  any non-empty effective permission set qualifies — per-page/per-action
 *  checks enforce the rest. */
export async function canAccessAdminArea(userId: string): Promise<boolean> {
  return (await resolveUserPermissions(userId)).size > 0;
}

/**
 * One-shot admin-shell gate + nav scoping (the `/admin` layout calls this).
 * Resolves the user's permissions ONCE and returns:
 *   - `ok`: may the user enter the admin area at all?
 *   - `grantedKeys`: every concrete `<module>:<action>` registry key they hold
 *      (wildcards already expanded) — or `null` when they hold the wildcard
 *      (sees everything; the shell skips per-item checks). The shell shows an
 *      item on `<id>:view`, or on its explicit `visibleWhen` grants (an item
 *      whose page guard is not `<id>:view` — see src/lib/rbac/nav-access.ts), so
 *      the full key list is sent rather than only the viewable module ids.
 */
export async function resolveAdminShellAccess(
  userId: string,
): Promise<{ ok: boolean; grantedKeys: string[] | null }> {
  const perms = await resolveUserPermissions(userId);
  if (perms.size === 0) return { ok: false, grantedKeys: [] };
  if (perms.has(WILDCARD)) return { ok: true, grantedKeys: null };
  return { ok: true, grantedKeys: expandGrantedKeys((m, a) => permissionSetAllows(perms, m, a)) };
}
