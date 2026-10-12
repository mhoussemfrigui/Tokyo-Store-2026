import type { Metadata } from "next";

import { rbacService } from "@/modules/rbac/service";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { AdminPageHeader } from "@/components/admin/page-header";

import { UsersSubnav } from "../users-subnav";
import { RolesManager } from "./roles-manager";

export const metadata: Metadata = {
  title: "Rôles & permissions",
};

export default async function RolesAdminPage() {
  // The session-policy editor moved to Utilisateurs → Réglages (/admin/users/settings);
  // this page is now roles-only. View needs users:view; create/edit/delete a role
  // is the grant power (users:roles) — a users:view-only operator reads roles but
  // sees no mutation controls (the actions re-check server-side).
  const session = await requirePermission("users", "view");
  const canManageRoles = permissionSetAllows(
    await resolveUserPermissions(session.user.id),
    "users",
    "roles",
  );
  const roles = await rbacService.listRolesWithCounts();
  // One batched grants query for all roles (was one SELECT per role — N+1).
  const permsByRole = await rbacService.listPermissionsForRoles(roles.map((r) => r.id));
  const withPermissions = roles.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    isSystem: r.is_system,
    permissionCount: r.permissionCount,
    userCount: r.userCount,
    permissions: permsByRole.get(r.id) ?? [],
  }));

  return (
    <div className="space-y-6">
      <UsersSubnav show={["comptes", "roles", "reglages"]} />
      <AdminPageHeader
        title="Rôles & permissions"
        description="Définissez des rôles avec un accès précis — par section et par action (voir, créer, modifier, supprimer, gérer). Assignez-les ensuite aux utilisateurs depuis leur fiche."
      />

      <RolesManager initialRoles={withPermissions} canManage={canManageRoles} />
    </div>
  );
}
