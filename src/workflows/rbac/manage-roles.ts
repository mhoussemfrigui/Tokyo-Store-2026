import "server-only";

import { z } from "zod";

import { rbacService } from "@/modules/rbac/service";
import { anyRoleHolderHasDenyOverride } from "@/lib/rbac/roster";
import { isValidPermissionKey, WILDCARD } from "@/lib/rbac/registry";
import {
  assertActorMayGrantPermissionKeys,
  assertRoleWildcardRemovalKeepsAnAdmin,
} from "@/lib/rbac/guards";
import { bus } from "@/events/bus";
import { fail, flattenZodError, ok, workflow } from "../shared";

/**
 * RBAC role-management workflows — create / update / delete a role and set its
 * permission grants. Permission keys are validated against the CODE registry
 * (`isValidPermissionKey`) so a typo or a stale key can never land in
 * `role_permissions`. System roles (super_admin) are protected: their key is
 * immutable and they can't be deleted.
 *
 * LOCKOUT / ESCALATION: a custom (non-system) role CAN carry '*' (a wildcard
 * super_admin minted it), and the role editor reaches accounts that also own a
 * customer profile, so such a role can be the SOLE effective '*' source. Access
 * is role-only, so stripping it is privilege-relevant — delete/update here must
 * enforce, exactly like the assign/disable paths:
 *   - actor-power: an actor may only delete/strip a role whose CURRENT grants it
 *     could itself wield (no gutting a role more powerful than yourself), and
 *   - a last-admin floor when the role currently grants '*'
 *     (`assertRoleWildcardRemovalKeepsAnAdmin`).
 */

/** name → stable slug key. Diacritics stripped, non-alnum → "_", collapsed. */
function slugifyKey(name: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return base || "role";
}

const permissionsSchema = z
  .array(z.string())
  .max(500)
  .transform((arr) => Array.from(new Set(arr)))
  .refine((arr) => arr.every(isValidPermissionKey), {
    message: "Permission inconnue (clé hors registre).",
  });

export const createRoleSchema = z.object({
  name: z.string().trim().min(2, "Nom requis (2+ caractères)").max(80),
  description: z.string().trim().max(280).optional(),
  permissions: permissionsSchema.default([]),
});
export type CreateRoleInput = z.input<typeof createRoleSchema>;

export const createRoleWorkflow = workflow<
  [CreateRoleInput, { actorUserId: string }],
  { roleId: string; key: string }
>("rbac.create_role", async (input, { actorUserId }) => {
  const parsed = createRoleSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  }
  const { name, description, permissions } = parsed.data;

  // A non-wildcard actor may only author a role whose grants are a SUBSET of its
  // own (no creating an over-powered role it could never wield).
  const denied = await assertActorMayGrantPermissionKeys(actorUserId, permissions);
  if (denied) return denied;

  // Derive a unique key from the name (super_admin etc. stay reserved by the
  // unique index — a collision just gets a numeric suffix).
  const base = slugifyKey(name);
  let key = base;
  for (let i = 2; await rbacService.findRoleByKey(key); i++) key = `${base}_${i}`;

  const role = await rbacService.createRole({ key, name, description: description ?? null });
  if (permissions.length > 0) {
    await rbacService.setRolePermissions(role.id, permissions);
  }

  await bus.emit("rbac.role_created", { roleId: role.id, key: role.key, name: role.name }, { actorUserId });
  if (permissions.length > 0) {
    await bus.emit(
      "rbac.role_permissions_set",
      { roleId: role.id, key: role.key, permissions },
      { actorUserId },
    );
  }
  return ok({ roleId: role.id, key: role.key });
});

export const updateRoleSchema = z.object({
  roleId: z.string().uuid(),
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().trim().max(280).nullable().optional(),
  permissions: permissionsSchema.optional(),
});
export type UpdateRoleInput = z.input<typeof updateRoleSchema>;

/**
 * STALE-KEY TOLERANCE. A key REMOVED from the registry can still be stored on a
 * role (a removal that shipped no role_permissions purge). The editor seeds its
 * state from the stored grants and sends them all back — the stale key isn't
 * rendered, so it can't be unticked — and the strict `permissionsSchema` would
 * then reject every save ("Validation échouée"), bricking the role. So drop an
 * unregistered key the role ALREADY holds (it confers nothing — authorization
 * ignores unknown keys — and the save below purges it); a NEW unknown key is
 * still rejected by the schema. (Same reasoning: the actor-power checks below
 * only weigh REGISTERED stored keys — a delegate must not be denied over a key
 * nobody can hold.)
 */
async function dropStoredStaleKeys(roleId: unknown, permissions: unknown): Promise<unknown> {
  if (!Array.isArray(permissions)) return permissions;
  if (permissions.every((k) => typeof k === "string" && isValidPermissionKey(k))) return permissions;
  if (!z.string().uuid().safeParse(roleId).success) return permissions;
  const stored = new Set(await rbacService.listPermissionsForRole(roleId as string));
  return permissions.filter(
    (k) => !(typeof k === "string" && !isValidPermissionKey(k) && stored.has(k)),
  );
}

export const updateRoleWorkflow = workflow<
  [UpdateRoleInput, { actorUserId: string }],
  { roleId: string }
>("rbac.update_role", async (input, { actorUserId }) => {
  const parsed = updateRoleSchema.safeParse({
    ...input,
    permissions: await dropStoredStaleKeys(input.roleId, input.permissions),
  });
  if (!parsed.success) {
    return fail("validation", "Validation échouée", flattenZodError(parsed.error));
  }
  const { roleId, name, description, permissions } = parsed.data;

  const role = await rbacService.findRoleById(roleId);
  if (!role) return fail("not_found", "Rôle introuvable.");
  // Defense-in-depth: system roles (super_admin) are immutable identity. The UI
  // hides their edit button, but a direct action call must also be refused —
  // otherwise an authorized caller could rename super_admin or strip its '*'
  // grant. Mirrors the deleteRoleWorkflow guard.
  if (role.is_system) {
    return fail("forbidden", "Ce rôle système ne peut pas être modifié.");
  }

  const currentGrants = await rbacService.listPermissionsForRole(roleId);
  // (b) ANY mutation (rename / description OR grant change): a non-wildcard actor
  //     may only touch a role whose CURRENT grants it could itself wield —
  //     otherwise a scoped `users` delegate could rename, gut or repurpose a role
  //     more powerful than itself. Runs for every update, not only grant replaces.
  const deniedCurrent = await assertActorMayGrantPermissionKeys(
    actorUserId,
    currentGrants.filter(isValidPermissionKey),
  );
  if (deniedCurrent) return deniedCurrent;

  // Grant-change guards (only when the permission set is being replaced):
  if (permissions !== undefined) {
    // (a) A non-wildcard actor may only set grants that are a SUBSET of its own.
    const deniedNew = await assertActorMayGrantPermissionKeys(actorUserId, permissions);
    if (deniedNew) return deniedNew;
    // (c) Last-admin floor: dropping '*' from the last '*'-carrying role must
    //     leave another effective super-admin.
    if (currentGrants.includes(WILDCARD) && !permissions.includes(WILDCARD)) {
      const floor = await assertRoleWildcardRemovalKeepsAnAdmin(roleId);
      if (floor) return floor;
    }
    // (d) PHANTOM prevention: NEWLY adding the global `*` to a role held by an
    //     account carrying a DENY override would materialize that holder's `*`
    //     away (overlay subtractDenies) — a "phantom" super-admin the gate + floor
    //     don't treat as `*`. Mirrors the assign-roles guard. Refuse; clear the
    //     holder's per-user restrictions first.
    if (!currentGrants.includes(WILDCARD) && permissions.includes(WILDCARD)) {
      if (await anyRoleHolderHasDenyOverride(roleId)) {
        return fail(
          "conflict",
          "Un compte portant ce rôle a des restrictions par utilisateur. Retirez-les avant d'élever ce rôle à l'accès total (« * »).",
        );
      }
    }
  }

  if (name !== undefined || description !== undefined) {
    await rbacService.updateRole(roleId, {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    });
    await bus.emit("rbac.role_updated", { roleId, key: role.key }, { actorUserId });
  }

  if (permissions !== undefined) {
    await rbacService.setRolePermissions(roleId, permissions);
    await bus.emit(
      "rbac.role_permissions_set",
      { roleId, key: role.key, permissions },
      { actorUserId },
    );
  }
  return ok({ roleId });
});

export const deleteRoleSchema = z.object({ roleId: z.string().uuid() });
export type DeleteRoleInput = z.input<typeof deleteRoleSchema>;

export const deleteRoleWorkflow = workflow<
  [DeleteRoleInput, { actorUserId: string }],
  { roleId: string }
>("rbac.delete_role", async (input, { actorUserId }) => {
  const parsed = deleteRoleSchema.safeParse(input);
  if (!parsed.success) return fail("validation", "Identifiant invalide.");

  const role = await rbacService.findRoleById(parsed.data.roleId);
  if (!role) return fail("not_found", "Rôle introuvable.");
  if (role.is_system) {
    return fail("forbidden", "Ce rôle système ne peut pas être supprimé.");
  }

  // Delete cascades away this role's grants + assignments. Guard it like the
  // assign/disable paths: the actor must be able to wield the role's CURRENT
  // grants, and if the role is a '*' source, another effective super-admin must
  // remain — otherwise deleting it locks everyone out of /admin.
  const currentGrants = await rbacService.listPermissionsForRole(role.id);
  const denied = await assertActorMayGrantPermissionKeys(
    actorUserId,
    currentGrants.filter(isValidPermissionKey), // stale keys confer nothing
  );
  if (denied) return denied;
  if (currentGrants.includes(WILDCARD)) {
    const floor = await assertRoleWildcardRemovalKeepsAnAdmin(role.id);
    if (floor) return floor;
  }

  await rbacService.deleteRole(role.id); // grants + assignments cascade
  await bus.emit("rbac.role_deleted", { roleId: role.id, key: role.key }, { actorUserId });
  return ok({ roleId: role.id });
});
