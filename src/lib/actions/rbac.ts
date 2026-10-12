"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";

/**
 * Server Actions for the Utilisateurs & rôles admin area.
 *
 * Gated by `requirePermission("users", <action>)`: super_admin's '*' satisfies
 * it, and a delegated role can perform exactly these operations (the workflows
 * then bound it to grants it holds itself — rbac/guards.ts). The privilege-GRANT
 * paths (role CRUD, assign-roles, per-user overlay) require `users:roles`, the
 * dedicated grant-power slice — so only a role explicitly carrying it can give
 * access to others; routine account ops stay on `users:manage`.
 * Object-arg (not FormData) so client components pass typed payloads and render
 * inline field errors.
 */

const ROLES_PATH = "/admin/users/roles";
const USERS_PATH = "/admin/users";

// ───────────────────────────────────────────────────────── roles
export async function createRoleAction(input: {
  name: string;
  description?: string;
  permissions: string[];
}): Promise<ActionState & { roleId?: string }> {
  const session = await requirePermission("users", "roles");
  const result = await workflows.rbac.createRole(
    { name: input.name, description: input.description, permissions: input.permissions },
    { actorUserId: session.user.id },
  );
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  }
  revalidatePath(ROLES_PATH);
  return { ok: true, message: "Rôle créé.", roleId: result.data.roleId };
}

export async function updateRoleAction(input: {
  roleId: string;
  name?: string;
  description?: string | null;
  permissions?: string[];
}): Promise<ActionState> {
  const session = await requirePermission("users", "roles");
  const result = await workflows.rbac.updateRole(input, { actorUserId: session.user.id });
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  }
  revalidatePath(ROLES_PATH);
  return { ok: true, message: "Rôle mis à jour." };
}

export async function deleteRoleAction(roleId: string): Promise<ActionState> {
  const session = await requirePermission("users", "roles");
  const result = await workflows.rbac.deleteRole({ roleId }, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath(ROLES_PATH);
  return { ok: true, message: "Rôle supprimé." };
}

// ───────────────────────────────────────────────────────── user ↔ roles
export async function setUserRolesAction(input: {
  userId: string;
  roleIds: string[];
}): Promise<ActionState> {
  const session = await requirePermission("users", "roles");
  const result = await workflows.rbac.setUserRoles(input, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath(USERS_PATH);
  revalidatePath(`${USERS_PATH}/${input.userId}`);
  return { ok: true, message: "Rôles mis à jour." };
}

// ───────────────────────────────────────────── user permission overlay (0191)
/**
 * Replace a user's per-user permission overlay (the allow/deny deltas over their
 * role baseline). Gated `users:roles` (the grant-power slice); the workflow
 * enforces the escalation guards (never `*`, only grant what you hold, must
 * out-rank the target, never self, never a role-super-admin).
 */
export async function setUserPermissionsAction(input: {
  userId: string;
  overrides: { permission: string; effect: "allow" | "deny" }[];
}): Promise<ActionState> {
  const session = await requirePermission("users", "roles");
  const result = await workflows.rbac.setUserPermissions(input, { actorUserId: session.user.id });
  if (!result.ok) return { ok: false, error: result.error, message: result.message };
  revalidatePath(USERS_PATH);
  revalidatePath(`${USERS_PATH}/${input.userId}`);
  return { ok: true, message: "Permissions mises à jour." };
}

// ───────────────────────────────────────────────────────── create user (with password)
export async function createUserAction(input: {
  email: string;
  firstName: string;
  lastName: string;
  password: string;
  phone?: string;
  roleIds?: string[];
}): Promise<ActionState & { userId?: string }> {
  const session = await requirePermission("users", "create");
  const result = await workflows.auth.createUser(
    {
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      password: input.password,
      phone: input.phone,
      roleIds: input.roleIds ?? [],
    },
    { actorUserId: session.user.id },
  );
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  }
  revalidatePath(USERS_PATH);
  revalidatePath("/admin/customers");
  return { ok: true, message: `Compte créé pour ${input.email}.`, userId: result.data.userId };
}

// ───────────────────────────────────────────────────────── set password (direct)
export async function setUserPasswordAction(input: {
  userId: string;
  newPassword: string;
}): Promise<ActionState> {
  const session = await requirePermission("users", "manage");
  const result = await workflows.auth.setPassword(input, { actorUserId: session.user.id });
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  }
  revalidatePath(USERS_PATH);
  return { ok: true, message: "Mot de passe mis à jour. Les sessions ont été révoquées." };
}

/**
 * Admin sets a user's LOGIN email directly (users:manage). Staff recovery for a
 * mistyped address (e.g. an employee locked out of /pro). Rank-guard + uniqueness
 * live in the workflow; the new address is marked UNVERIFIED and every session
 * revoked (email = identity). Mirrors {@link setUserPasswordAction} (a direct
 * change, no mail sent → no separate rate limit; users:manage is the gate).
 */
export async function adminSetUserEmailAction(input: {
  userId: string;
  newEmail: string;
}): Promise<ActionState> {
  const session = await requirePermission("users", "manage");
  const result = await workflows.auth.setEmail(input, { actorUserId: session.user.id });
  if (!result.ok) {
    return { ok: false, error: result.error, message: result.message, fieldErrors: result.fieldErrors };
  }
  revalidatePath(USERS_PATH);
  return { ok: true, message: "Email mis à jour (non vérifié). Les sessions ont été révoquées." };
}
