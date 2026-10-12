import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ShieldCheck } from "lucide-react";

import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { requirePermission } from "@/lib/auth/session";
import { resolveAccountType, resolveUserPermissions } from "@/lib/rbac/authorize";
import { ACCOUNT_TYPE_LABEL } from "@/lib/rbac/account-type";
import { isValidPermissionKey, WILDCARD } from "@/lib/rbac/registry";
import { customerUserLink } from "@/associations/customer-user.service";

import { UserRolesEditor } from "../../user-roles-editor";
import { UserPermissionsEditor } from "../user-permissions-editor";

export const metadata: Metadata = { title: "Rôles & accès" };

/**
 * Système → Utilisateurs → « Rôles & accès » for ONE account: the role assignment
 * + the per-user allow/deny permission overlay (the detailed matrix). It is its
 * OWN page, gated on the GRANT power (`users:roles`), so editing who-can-do-what
 * is reachable only by operators who hold that power — and from ONE place for
 * EVERY account, including those that own a customer profile (this page does NOT
 * redirect to the Clients 360; the 360 and the user fiche link here with a button).
 * Granular RBAC is a platform-administration concern, not a customer-record one.
 */
export default async function UserAccessPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requirePermission("users", "roles");
  const user = await authService.findById(id);
  if (!user) notFound();

  // Only a full (wildcard) admin may assign SYSTEM roles (e.g. super_admin);
  // defense-in-depth over setUserRolesWorkflow. Baseline = union of the assigned
  // roles' grants; overrides self-healed against the live registry.
  const [actorPerms, allRoles, assignedRoles, baselineGrants, rawOverrides, targetType, profiles] =
    await Promise.all([
      resolveUserPermissions(session.user.id),
      rbacService.listRoles(),
      rbacService.listRolesForUser(id),
      rbacService.listPermissionsForUser(id),
      rbacService.listUserPermissionOverrides(id),
      resolveAccountType(id),
      customerUserLink.findProfileSummariesByUserIds([id]),
    ]);
  const actorIsWildcard = actorPerms.has(WILDCARD);
  const targetIsWildcard = targetType === "admin";
  const initialOverrides = rawOverrides.filter((o) => isValidPermissionKey(o.permission));
  // Back to wherever this account's record lives (the 360 for a profile owner, else the fiche).
  const liveProfile = profiles.get(id);
  const backHref = liveProfile ? `/admin/customers/${liveProfile.profileId}` : `/admin/users/${id}`;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour à la fiche
        </Link>
        <h1 className="mt-2 text-[26px] font-black tracking-[-0.02em] text-foreground sm:text-[30px]">
          Rôles &amp; accès
        </h1>
        <p className="mt-1 text-[14px] text-muted-foreground">
          {user.name || user.email} · {user.email} · {ACCOUNT_TYPE_LABEL[targetType]}
        </p>
      </div>

      <section className="rounded-[22px] border border-border bg-card p-5">
        <h2 className="mb-3 inline-flex items-center gap-2 text-[18px] font-black text-foreground">
          <ShieldCheck className="h-4 w-4" /> Rôles d&apos;accès
        </h2>
        <UserRolesEditor
          userId={user.id}
          allRoles={allRoles
            .filter((r) => actorIsWildcard || !r.is_system)
            .map((r) => ({ id: r.id, name: r.name, isSystem: r.is_system }))}
          assignedIds={assignedRoles.map((r) => r.id)}
        />
      </section>

      <section className="rounded-[22px] border border-border bg-card p-5">
        <div className="mb-3">
          <h2 className="inline-flex items-center gap-2 text-[18px] font-black text-foreground">
            <ShieldCheck className="h-4 w-4" /> Permissions détaillées
          </h2>
          <p className="mt-1 max-w-3xl text-[13px] text-muted-foreground">
            Les rôles ci-dessus donnent l&apos;accès de base — un modèle. Ajustez ici finement :
            ajoutez ou retirez des actions précises pour CE compte, sans créer de rôle dédié.
          </p>
        </div>
        <UserPermissionsEditor
          userId={user.id}
          baselineGrants={baselineGrants}
          initialOverrides={initialOverrides}
          targetIsWildcard={targetIsWildcard}
        />
      </section>
    </div>
  );
}
