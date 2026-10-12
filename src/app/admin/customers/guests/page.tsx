import type { Metadata } from "next";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { listFilteredGuests, guestFilterStats } from "@/lib/customers/guest-filter";
import { EMPTY_GUEST_FILTER } from "@/lib/customers/guest-filter-shared";

import { GuestsBrowser } from "./guests-browser";

export const metadata: Metadata = { title: "Clients invités" };
// Live guest data + stats — never statically cache this surface.
export const dynamic = "force-dynamic";

export default async function GuestClientsPage() {
  const session = await requirePermission("invites", "view");
  const perms = await resolveUserPermissions(session.user.id);
  const canExport = permissionSetAllows(perms, "invites", "export");
  // The guest rows deep-link to /admin/customers/[id] (customers:view) and
  // /admin/orders (orders:view). `invites` is its own module, so an invites-only
  // operator holds neither — render those links only when the target would open
  // (UI honesty; the target pages requirePermission → notFound on deny).
  const canViewCustomers = permissionSetAllows(perms, "customers", "view");
  const canViewOrders = permissionSetAllows(perms, "orders", "view");

  // First page + stats for the empty filter (the whole guest base).
  const [list, stats] = await Promise.all([
    listFilteredGuests(EMPTY_GUEST_FILTER, { limit: 30 }),
    guestFilterStats(EMPTY_GUEST_FILTER),
  ]);

  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Clients invités"
        description="Commandes passées sans compte, regroupées par email + téléphone. Elles sont rattachées à un compte (et les commandes payées comptabilisées dans la dépense du client) quand un compte est créé et vérifié avec le même email — ou créé / invité par un administrateur avec cet email. Le téléphone seul ne suffit pas."
      />

      <GuestsBrowser
        initialItems={list.items}
        initialNextCursor={list.nextCursor}
        initialStats={stats}
        canExport={canExport}
        canViewCustomers={canViewCustomers}
        canViewOrders={canViewOrders}
      />
    </div>
  );
}
