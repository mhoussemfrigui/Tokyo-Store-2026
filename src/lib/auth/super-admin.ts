import "server-only";

import { bus } from "@/events/bus";
import { requirePermission } from "@/lib/auth/session";
import { resolveUserPermissions } from "@/lib/rbac/authorize";
import { WILDCARD, type PermissionAction, type PermissionModuleId } from "@/lib/rbac/registry";

/**
 * Super-admin step-up gate for the IRREVERSIBLE, store-wide operations — the
 * purge-and-relaunch and the segmented data-job cleanups it drives (the headless
 * `POST /api/admin/system/demo?op=clear`). A module grant such as
 * `system_demo:manage` ("Importer la démo") or `system_jobs:manage` ("Tâches
 * planifiées") must NOT, on its own, let a delegated role wipe the catalogue and
 * archive every customer — those also require the RBAC `*` wildcard.
 *
 * Plain (non-"use server") module on purpose: exporting these from a
 * `"use server"` file would publish them as callable Server Actions.
 */

export type StaffSession = Awaited<ReturnType<typeof requirePermission>>;

/** True iff the live user holds the RBAC `*` wildcard (super-admin). No side effects. */
export async function isSuperAdmin(userId: string): Promise<boolean> {
  return (await resolveUserPermissions(userId)).has(WILDCARD);
}

/**
 * {@link isSuperAdmin} for a caller that is about to REFUSE: a staff member who
 * already passed the module grant but lacks `*` is probing past their role, so
 * the denial is recorded on the security trail (`rbac.permission_denied` with
 * module "*", like a `requirePermission` denial). Best-effort — never changes
 * the outcome.
 */
export async function checkSuperAdmin(userId: string): Promise<boolean> {
  if (await isSuperAdmin(userId)) return true;
  await bus
    .emit("rbac.permission_denied", { actorUserId: userId, module: "*", action: "admin" }, { actorUserId: userId })
    .catch(() => {});
  return false;
}

/**
 * Module grant FIRST (404 on deny, like every admin surface — no leak), THEN the
 * `*` wildcard. A staff member holding the grant but not `*` gets `{ ok: false }`
 * so the caller answers with a clear French refusal instead of a bare 404.
 */
export async function requireSuperAdmin(
  module: PermissionModuleId,
  action: PermissionAction,
): Promise<{ ok: true; session: StaffSession } | { ok: false }> {
  const session = await requirePermission(module, action);
  if (!(await checkSuperAdmin(session.user.id))) return { ok: false };
  return { ok: true, session };
}
