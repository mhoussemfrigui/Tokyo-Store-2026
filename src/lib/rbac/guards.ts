import "server-only";

import { and, eq, isNull, ne, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { users } from "@/modules/auth/schema";
import { user_roles, role_permissions } from "@/modules/rbac/schema";
import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { WILDCARD, type PermissionAction, type PermissionModuleId } from "@/lib/rbac/registry";
import type { RoleRow } from "@/modules/rbac/schema";

/**
 * RBAC ESCALATION GUARDS — the "no privilege above your own" rules that the
 * coarse `requirePermission("users", …)` gate cannot express.
 *
 * The user-and-role administration surface is governed by a single permission
 * tier (`users:create` / `users:manage`). Without these guards a delegated
 * "users manager" role — exactly the least-privilege delegate RBAC exists to
 * enable — could:
 *   - assign itself (or anyone) the wildcard-carrying super_admin role,
 *   - reset / disable / re-target an existing super_admin's account and take it
 *     over.
 * The fix is uniform: an actor may only grant privileges it ALREADY HOLDS, and
 * may only act on a target that does NOT out-rank it — unless the actor holds
 * the global wildcard, in which case it may do anything (super_admin).
 *
 * Each guard returns a `GuardDenial` (assignable to a `WorkflowFail` / the
 * action `ActionState` failure shape) on refusal, or `null` when allowed — so
 * call sites stay `const denied = await assertX(...); if (denied) return denied;`.
 */
export type GuardDenial = { ok: false; error: string; message: string };

const deny = (message: string): GuardDenial => ({ ok: false, error: "forbidden", message });

/**
 * Does an effective permission set satisfy a single grant KEY? Honours the
 * global wildcard ("*"), a per-module wildcard ("<module>:*", required when the
 * key itself is a module wildcard), and a concrete "<module>:<action>".
 */
function permsAllowKey(perms: Set<string>, key: string): boolean {
  if (perms.has(WILDCARD)) return true;
  if (key === WILDCARD) return false; // only "*" satisfies "*", handled above
  const idx = key.indexOf(":");
  if (idx <= 0) return false;
  const module = key.slice(0, idx);
  const action = key.slice(idx + 1);
  if (action === "*") return perms.has(`${module}:*`);
  return permissionSetAllows(perms, module as PermissionModuleId, action as PermissionAction);
}

/**
 * A target's LATENT privilege set — like `resolveUserPermissions` but does NOT
 * zero a DISABLED account. A disabled super_admin still reads as wildcard here,
 * so a lesser actor can't act on (e.g. re-enable) them through a hole that only
 * the disabled-state masking would open.
 *
 * It unions the role grants with the target's per-user ALLOW overrides — the SAME
 * allow-set `resolveAccountType` derives — because an allow-override genuinely
 * ELEVATES the target (it adds to the effective set). Reading role grants alone
 * would under-rank an overlay-elevated account, letting a lesser actor seize it
 * (reset its password / repoint its email / disable it) via `assertActorOutranksTarget`.
 * We take the allow-union, NOT the deny-subtracted effective set: a per-user DENY
 * is a restriction and must never LOWER a target's rank (same deliberate choice as
 * `resolveAccountType`). The latent (don't-zero-on-disabled) property holds because
 * this never calls `resolveUserPermissions`.
 */
async function latentTargetPerms(userId: string): Promise<Set<string>> {
  const row = await authService.findById(userId);
  if (!row) return new Set();
  const [roleGrants, overrides] = await Promise.all([
    rbacService.listPermissionsForUser(userId),
    rbacService.listUserPermissionOverrides(userId),
  ]);
  return new Set<string>([
    ...roleGrants,
    ...overrides.filter((o) => o.effect !== "deny").map((o) => o.permission),
  ]);
}

/**
 * Refuse when the ACTOR does not out-rank the TARGET: i.e. the target holds a
 * grant the actor lacks. Wildcard actors pass (may manage anyone); self is
 * always allowed (callers add their own self-action guards where a self-op is
 * undesirable, e.g. self-demotion). Used by every account-mutating admin op
 * (set-password, disable, enable, force-logout, set-email-verified, set-roles,
 * reset-link) so a delegate can never seize a higher account.
 */
export async function assertActorOutranksTarget(
  actorUserId: string,
  targetUserId: string,
): Promise<GuardDenial | null> {
  if (actorUserId === targetUserId) return null;
  const actor = await resolveUserPermissions(actorUserId);
  if (actor.has(WILDCARD)) return null;
  const target = await latentTargetPerms(targetUserId);
  for (const key of target) {
    if (!permsAllowKey(actor, key)) {
      return deny("Action interdite : ce compte dispose de privilèges supérieurs aux vôtres.");
    }
  }
  return null;
}

/**
 * Refuse when the ACTOR lacks the dedicated GRANT power — the `users:roles` verb
 * (or the global wildcard). The capability to give access to others (assign a
 * role on create/invite, assign on an existing account, author a role, set a
 * per-user overlay) is its OWN slice: a `users:create`-only operator can mint a
 * plain account but must NOT be able to attach roles to it. Called by every
 * role-granting entry point in addition to its own gate. (Granting a role you
 * don't out-rank is separately blocked by `assertActorMayGrantRole`.)
 */
export async function assertActorMayAssignRoles(
  actorUserId: string,
): Promise<GuardDenial | null> {
  const actor = await resolveUserPermissions(actorUserId);
  if (actor.has(WILDCARD)) return null;
  if (permissionSetAllows(actor, "users", "roles")) return null;
  return deny(
    "Attribuer un rôle nécessite la permission « Rôles & accès » (users:roles).",
  );
}

/**
 * Refuse when the ACTOR may not grant the given ROLE: a system role (e.g.
 * super_admin) requires the wildcard, and a custom role may only be granted if
 * the actor already holds every permission that role carries (no granting a
 * role more powerful than yourself). Wildcard actors pass.
 */
export async function assertActorMayGrantRole(
  actorUserId: string,
  role: Pick<RoleRow, "id" | "is_system">,
): Promise<GuardDenial | null> {
  const actor = await resolveUserPermissions(actorUserId);
  if (actor.has(WILDCARD)) return null;
  if (role.is_system) {
    return deny("Seul un super-administrateur peut attribuer un rôle système.");
  }
  const grants = await rbacService.listPermissionsForRole(role.id);
  for (const key of grants) {
    if (!permsAllowKey(actor, key)) {
      return deny("Vous ne pouvez pas attribuer un rôle disposant de privilèges supérieurs aux vôtres.");
    }
  }
  return null;
}

/**
/**
 * A user is a TRUE effective super-admin only if they hold `*` via a role AND
 * carry NO per-user DENY override. The overlay (lib/rbac/overlay.ts) materializes
 * `*` into concrete keys the moment ANY deny exists, dropping the literal `*`
 * token — so `resolveUserPermissions(x).has('*')` is FALSE for a role-`*` holder
 * with any deny. The floor MUST match the gate, or it would count such a
 * "phantom" super-admin and let the last REAL `*` holder be removed → lockout.
 * (An ALLOW-only override keeps `*` intact, so only denies disqualify.)
 */
const WITHOUT_DENY_OVERRIDE = sql`not exists (
  select 1 from user_permissions up
  where up.user_id = ${users.id} and up.effect = 'deny'
)`;

/**
 * Count the ACTIVE accounts that hold the global wildcard `*` — the effective
 * "super-administrators". The sole source of `*` is an RBAC role granting it
 * (the legacy `users.role` enum bridge was retired in the Stage-4 migration),
 * AND the account must carry no deny override (see {@link WITHOUT_DENY_OVERRIDE}).
 * A disabled account never counts (it can't act). Optionally EXCLUDE one user id
 * (to ask "is anyone OTHER than this user still an admin?").
 *
 * This is the cross-module floor the RBAC role-removal + account-disable paths
 * both gate on: without it either could strip the last effective `*` holder and
 * lock everyone out. Lives here (the cross-cutting RBAC layer), not in a single
 * module's service, because it joins `users` × the RBAC tables.
 */
export async function countEffectiveWildcardAdmins(excludeUserId?: string): Promise<number> {
  const conditions = [
    isNull(users.disabledAt),
    eq(role_permissions.permission, WILDCARD),
    WITHOUT_DENY_OVERRIDE,
  ];
  if (excludeUserId) conditions.push(ne(users.id, excludeUserId));

  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .leftJoin(user_roles, eq(user_roles.user_id, users.id))
    .leftJoin(
      role_permissions,
      and(eq(role_permissions.role_id, user_roles.role_id), eq(role_permissions.permission, WILDCARD)),
    )
    .where(and(...conditions));
  return rows.length;
}

/**
 * Count ACTIVE accounts that would STILL hold the global wildcard `*` if role
 * `roleId` stopped granting it — i.e. `*` via a role OTHER than `roleId`. This is
 * the floor the role-management path needs: deleting a role cascades away its
 * `role_permissions` + `user_roles`, and replacing its grants drops its `*`, so a
 * custom role that is the SOLE `*` source could otherwise strip the last admin.
 * A deny override disqualifies (see {@link WITHOUT_DENY_OVERRIDE}) — same
 * gate-matching rule as {@link countEffectiveWildcardAdmins}.
 */
export async function countWildcardAdminsExcludingRole(roleId: string): Promise<number> {
  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .leftJoin(user_roles, eq(user_roles.user_id, users.id))
    .leftJoin(
      role_permissions,
      and(
        eq(role_permissions.role_id, user_roles.role_id),
        eq(role_permissions.permission, WILDCARD),
        ne(role_permissions.role_id, roleId), // '*' from ANOTHER role only
      ),
    )
    .where(and(isNull(users.disabledAt), eq(role_permissions.permission, WILDCARD), WITHOUT_DENY_OVERRIDE));
  return rows.length;
}

/**
 * Refuse deleting a role (or replacing its grants) that would remove the LAST
 * effective super-admin. Only meaningful when the role currently grants `*`; the
 * caller checks that and passes the role id here. (Same small-N TOCTOU residual
 * as `assertRoleChangeKeepsAnAdmin` — acceptable vs. the prior state, which had
 * NO floor on this path at all.)
 */
export async function assertRoleWildcardRemovalKeepsAnAdmin(
  roleId: string,
): Promise<GuardDenial | null> {
  const remaining = await countWildcardAdminsExcludingRole(roleId);
  if (remaining === 0) {
    return deny(
      "Vous ne pouvez pas supprimer ou vider ce rôle : il détient le dernier accès super-administrateur (aucun autre ne resterait).",
    );
  }
  return null;
}

/**
 * Refuse DISABLING (or deleting) an account that is the LAST effective
 * super-admin. The effective-admin set is the RBAC `*` holders (an account can
 * hold `*` while owning a customer profile, since the role editor reaches
 * customer-360 accounts), so disabling/deleting such a holder via a customer-area
 * action could strip the final admin and lock everyone out without this floor.
 *
 * Returns null when the target is not an effective `*` holder (no floor risk) or
 * when another active `*` holder remains; a denial otherwise. (Same documented
 * small-N TOCTOU residual as `assertRoleChangeKeepsAnAdmin`.)
 */
export async function assertDisableKeepsAnAdmin(
  targetUserId: string,
): Promise<GuardDenial | null> {
  const targetPerms = await resolveUserPermissions(targetUserId);
  if (!targetPerms.has(WILDCARD)) return null; // not an effective admin → safe
  const others = await countEffectiveWildcardAdmins(targetUserId);
  if (others === 0) {
    return deny(
      "Vous ne pouvez pas désactiver le dernier administrateur : aucun autre super-administrateur ne resterait.",
    );
  }
  return null;
}

/**
 * Refuse a role-set change that would remove the LAST effective super-admin.
 * Only meaningful when the change REMOVES a `*`-carrying role from the target.
 * The target keeps `*` (and we allow the change) if any role in the DESIRED set
 * still grants `*`; otherwise we require at least one OTHER active `*` holder to
 * remain. Runs unconditionally — including a self-targeted removal (an admin must
 * not lock themselves out as the last one).
 *
 * (Residual: two SIMULTANEOUS last-two removals could both pass the read before
 * either writes — a theoretical TOCTOU on a handful of super-admins. Acceptable
 * vs. the current state, which has NO floor on this path at all.)
 */
export async function assertRoleChangeKeepsAnAdmin(
  targetUserId: string,
  desiredRoleIds: string[],
): Promise<GuardDenial | null> {
  // Target stays an effective admin via a RETAINED role that grants '*'? → no floor risk.
  if (desiredRoleIds.length > 0) {
    const desiredPerms = await rbacService.listPermissionsForRoles(desiredRoleIds);
    for (const perms of desiredPerms.values()) {
      if (perms.includes(WILDCARD)) return null; // a retained/added role still grants '*'
    }
  }
  // Target will NOT hold '*' after the change. Require another active '*' holder.
  const others = await countEffectiveWildcardAdmins(targetUserId);
  if (others === 0) {
    return deny(
      "Vous ne pouvez pas retirer le dernier administrateur : aucun autre super-administrateur ne resterait.",
    );
  }
  return null;
}

/**
 * Refuse when the ACTOR would WRITE a role/grant carrying a permission KEY it
 * does not itself hold. Defense-in-depth on role authoring (create/update role):
 * assignment is already guarded by assertActorMayGrantRole, but this also keeps
 * a delegate from persisting an over-powered role row (e.g. one bearing '*' or a
 * module it lacks) that could later confuse a higher actor. Wildcard actors pass.
 */
export async function assertActorMayGrantPermissionKeys(
  actorUserId: string,
  keys: string[],
): Promise<GuardDenial | null> {
  const actor = await resolveUserPermissions(actorUserId);
  if (actor.has(WILDCARD)) return null;
  for (const key of keys) {
    if (!permsAllowKey(actor, key)) {
      return deny("Vous ne pouvez accorder que des permissions que vous détenez vous-même.");
    }
  }
  return null;
}
