import type { Metadata } from "next";

import { authService } from "@/modules/auth/service";
import { rbacService } from "@/modules/rbac/service";
import { customerUserLink } from "@/associations/customer-user.service";
import { requirePermission } from "@/lib/auth/session";
import { accountTypeCounts, accountTypesForUsers } from "@/lib/rbac/roster";
import { AdminPageHeader } from "@/components/admin/page-header";
import { AdminKpiStrip } from "@/components/admin/kpi-strip";

import { UsersSubnav } from "./users-subnav";
import { InviteUserForm } from "./invite-user-form";
import { CreateUserForm } from "./create-user-form";
import { UsersTable } from "./users-table";

export const metadata: Metadata = {
  title: "Utilisateurs",
};

const PAGE_SIZE = 25;

export default async function UsersAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; cursor?: string; statut?: string }>;
}) {
  const sp = await searchParams;
  await requirePermission("users", "view");
  // Active/disabled filter — default "all" preserves the previous behaviour
  // (the list always showed disabled accounts too).
  const status: "active" | "disabled" | "all" =
    sp.statut === "active" || sp.statut === "disabled" ? sp.statut : "all";

  const [result, roles, total, active] = await Promise.all([
    authService.list({ search: sp.q, cursor: sp.cursor, limit: PAGE_SIZE, status }),
    rbacService.listRoles(),
    authService.count({ status: "all" }),
    authService.count({ status: "active" }),
  ]);
  const roleOptions = roles.map((r) => ({ id: r.id, name: r.name }));
  // Account TYPE (client/staff/admin) is DERIVED from RBAC grants now — no enum.
  const typeCounts = await accountTypeCounts(total);

  // Which of THIS page's users own a customer profile → link those rows straight
  // to the 360, show the "Client" badge, AND render the LIVE profile name (one
  // batched lookup, no N+1). Reading the profile name live keeps the list correct
  // even when the denormalised `users.name` lags a profile rename.
  // The derived account TYPE for this page's rows comes from ONE grouped RBAC
  // query (accountTypesForUsers) — never a per-row resolve.
  const pageUserIds = result.items.map((u) => u.id);
  const [profileByUser, typeByUser] = await Promise.all([
    customerUserLink.findProfileSummariesByUserIds(pageUserIds),
    accountTypesForUsers(pageUserIds),
  ]);

  return (
    <div className="space-y-6">
      <UsersSubnav show={["comptes", "roles", "reglages"]} />
      <AdminPageHeader
        title="Utilisateurs"
        description="Tous les comptes (clients, staff, admins) — filtrez par statut ou recherchez par email / nom. Le type de compte est déduit des rôles d'accès."
      />

      {/* Controls anchored in their own header card so they don't float loose on
          the canvas — kept a sibling row (NOT the shared header's action slot,
          which is shrink-0 and would clip the inline w-full form cards). */}
      <div className="flex flex-wrap items-center gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <CreateUserForm roles={roleOptions} />
        <InviteUserForm roles={roleOptions} />
      </div>

      <AdminKpiStrip
        items={[
          { label: "Comptes", value: total },
          { label: "Actifs", value: active, tone: "success" },
          { label: "Désactivés", value: total - active, tone: total - active > 0 ? "warning" : "muted" },
          { label: "Admins", value: typeCounts.admins, tone: "info" },
          { label: "Staff", value: typeCounts.staff },
          { label: "Clients", value: typeCounts.customers },
        ]}
      />

      <UsersTable
        initialItems={result.items.map((u) => {
          const profile = profileByUser.get(u.id);
          // Linked customers: show the LIVE profile name (drift-proof); fall back
          // to the denormalised users.name (staff/admin, or a blank profile name).
          const liveName = profile
            ? `${profile.firstName} ${profile.lastName}`.trim()
            : "";
          return {
            id: u.id,
            email: u.email,
            name: liveName || u.name,
            accountType: typeByUser.get(u.id) ?? "customer",
            emailVerified: u.emailVerified,
            disabled: !!u.disabledAt,
            createdAt: u.createdAt.toISOString(),
            customerProfileId: profile?.profileId ?? null,
          };
        })}
        nextCursor={result.nextCursor}
        currentSearch={sp.q ?? ""}
        currentStatus={status}
      />
    </div>
  );
}
