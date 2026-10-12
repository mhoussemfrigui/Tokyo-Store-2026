import type { Metadata } from "next";

import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { listFilteredCustomers, customerFilterStats } from "@/lib/customers/filter";
import { EMPTY_CUSTOMER_FILTER } from "@/lib/customers/filter-shared";

import { InviteClientForm } from "./invite-client-form";
import { CustomersBrowser } from "./customers-browser";

export const metadata: Metadata = { title: "Clients" };
// Live customer data + stats — never statically cache this surface.
export const dynamic = "force-dynamic";

export default async function CustomersAdminPage() {
  const session = await requirePermission("customers", "view");

  // The "Inviter un client" flow creates a login account → gated on `users:create`.
  const perms = await resolveUserPermissions(session.user.id);
  const canInvite = permissionSetAllows(perms, "users", "create");
  // The bulk PII export (also its own filtered variant) is its own grant.
  const canExport = permissionSetAllows(perms, "customers", "export");

  // First page + stats for the empty filter (whole registered-customer base).
  const [list, stats] = await Promise.all([
    listFilteredCustomers(EMPTY_CUSTOMER_FILTER, { limit: 30 }),
    customerFilterStats(EMPTY_CUSTOMER_FILTER),
  ]);

  return (
    <div className="space-y-6">
      <InviteClientForm
        canInvite={canInvite}
        title="Clients"
        description="Profils clients — statistiques, filtres (genre, coupons, panier, marketing, dates…), et export filtré."
      />

      <CustomersBrowser
        initialRows={list.rows}
        initialNextCursor={list.nextCursor}
        initialStats={stats}
        canExport={canExport}
      />
    </div>
  );
}
