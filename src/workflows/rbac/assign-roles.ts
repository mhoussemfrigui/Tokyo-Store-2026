import "server-only";

import { z } from "zod";

import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import {
  assertActorMayGrantRole,
  assertActorOutranksTarget,
  assertRoleChangeKeepsAnAdmin,
} from "@/lib/rbac/guards";
import { WILDCARD } from "@/lib/rbac/registry";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Replace a user's full set of RBAC role assignments (the multi-select in the
 * admin user panel sends the desired set; we diff against the current set and
 * apply the minimal add/remove). All target roles must exist. Emits
 * `user.roles_changed` with the resulting set.
 *
 * Access is role-only (the legacy enum was retired). Removing a role that grants
 * the global wildcard CAN drop the last effective super-admin, so this workflow
 * enforces a last-admin floor over the RBAC `*` holders via
 * `assertRoleChangeKeepsAnAdmin`.
 *
 * ESCALATION GUARDS (no privilege above your own): a non-wildcard actor may not
 * touch a target that out-ranks them, nor ADD a role that is a system role or
 * carries a permission they lack — otherwise a delegated "users manager" could
 * self-assign super_admin. Removal is unrestricted (de-escalation is safe).
 */
export const setUserRolesSchema = z.object({
  userId: z.string().min(1),
  roleIds: z.array(z.string().uuid()).max(50).transform((a) => Array.from(new Set(a))),
});
export type SetUserRolesInput = z.input<typeof setUserRolesSchema>;

export const setUserRolesWorkflow = workflow<
  [SetUserRolesInput, { actorUserId: string }],
  { userId: string; roleIds: string[] }
>("rbac.set_user_roles", async (input, { actorUserId }) => {
  const parsed = setUserRolesSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Données invalides.");
  const { userId, roleIds } = parsed.data;

  const user = await authService.findById(userId);
  if (!user) return fail("not_found", "Utilisateur introuvable.");

  // A non-wildcard actor may not modify the roles of a higher-privileged target.
  const outranked = await assertActorOutranksTarget(actorUserId, userId);
  if (outranked) return outranked;

  // Every desired role must exist (guard against a stale/forged id).
  const roleById = new Map<string, Awaited<ReturnType<typeof rbacService.findRoleById>>>();
  for (const roleId of roleIds) {
    const role = await rbacService.findRoleById(roleId);
    if (!role) return fail("not_found", "Rôle introuvable.");
    roleById.set(roleId, role);
  }

  const current = (await rbacService.listRolesForUser(userId)).map((r) => r.id);
  const currentSet = new Set(current);
  const desiredSet = new Set(roleIds);

  const toAdd = roleIds.filter((id) => !currentSet.has(id));
  const toRemove = current.filter((id) => !desiredSet.has(id));

  // A non-wildcard actor may only ADD roles it could itself wield (no granting
  // a system role or any permission above your own). Removal stays unrestricted.
  for (const roleId of toAdd) {
    const role = roleById.get(roleId)!;
    const denied = await assertActorMayGrantRole(actorUserId, role);
    if (denied) return denied;
  }

  // PHANTOM-SUPER-ADMIN prevention: granting a role that carries the global `*` to
  // a target that has per-user DENY overrides would make the overlay MATERIALIZE
  // the `*` to concrete keys (overlay.ts subtractDenies) — yielding a "super-admin"
  // the gate doesn't read as `*` (so the last-admin floor's WITHOUT_DENY_OVERRIDE
  // excludes it) AND whose overlay is then un-editable (set-user-permissions refuses
  // role-`*` targets) → a confusing, stuck state. Refuse and make the operator clear
  // the restrictions first. (A fresh create/invite has no overlay, so only this
  // existing-account path needs the check.)
  if (toAdd.length > 0) {
    const addedPerms = await rbacService.listPermissionsForRoles(toAdd);
    const addingWildcard = Array.from(addedPerms.values()).some((p) => p.includes(WILDCARD));
    if (addingWildcard) {
      const overrides = await rbacService.listUserPermissionOverrides(userId);
      if (overrides.some((o) => o.effect === "deny")) {
        return fail(
          "conflict",
          "Ce compte a des restrictions par utilisateur (permissions retirées). Retirez-les avant de lui accorder un rôle à accès total (super-administrateur).",
        );
      }
    }
  }

  // LAST-ADMIN FLOOR: if this change REMOVES a role that grants the global
  // wildcard, ensure it doesn't strip the final super-admin. Only pay the cost
  // when a wildcard-carrying role is actually being removed. Runs even for self.
  if (toRemove.length > 0) {
    const removedPerms = await rbacService.listPermissionsForRoles(toRemove);
    const removingWildcardRole = Array.from(removedPerms.values()).some((p) =>
      p.includes(WILDCARD),
    );
    if (removingWildcardRole) {
      const denied = await assertRoleChangeKeepsAnAdmin(userId, roleIds);
      if (denied) return denied;
    }
  }

  for (const roleId of toAdd) await rbacService.assignRoleToUser(userId, roleId);
  for (const roleId of toRemove) await rbacService.removeRoleFromUser(userId, roleId);

  // De-escalation (a role was REMOVED) → revoke the target's live sessions so
  // they re-authenticate under the reduced grant set, mirroring the disable
  // path. The per-request gates already resolve perms
  // LIVE so this isn't a privilege-escalation fix — it's consistency + active
  // forced re-auth (no waiting out the cookie cache).
  if (toRemove.length > 0) {
    await authService.deleteSessionsForUser(userId);
  }

  if (toAdd.length > 0 || toRemove.length > 0) {
    await bus.emit("user.roles_changed", { userId, roleIds }, { actorUserId });
  }
  return ok({ userId, roleIds });
});
