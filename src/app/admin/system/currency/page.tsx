import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { AdminPageHeader } from "@/components/admin/page-header";
import { currencyQueries } from "@/modules/currency";
import { CurrencyPanel } from "./currency-panel";

export const metadata: Metadata = { title: "Devises" };

/**
 * Currency registry (Commandes → Devises). ONE active currency labels prices
 * across the storefront / JSON-LD / new orders — it does NOT convert stored
 * amounts (relabel only; the owner re-prices). TND is seeded active.
 */
export default async function CurrencySettingsPage() {
  const session = await requirePermission("system_currency", "view");
  // Hide the controls a view-only role lacks (the actions re-check server-side).
  const perms = await resolveUserPermissions(session.user.id);
  const can = {
    canCreate: permissionSetAllows(perms, "system_currency", "create"),
    canUpdate: permissionSetAllows(perms, "system_currency", "update"),
    canDelete: permissionSetAllows(perms, "system_currency", "delete"),
  };
  const currencies = await currencyQueries.list().catch(() => []);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/system"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour au Système
        </Link>
        <div className="mt-2">
          <AdminPageHeader
            title="Devises"
            description="La devise ACTIVE étiquette tous les prix (boutique, données structurées, nouvelles commandes). Changer de devise NE convertit PAS les montants enregistrés — c'est un ré-étiquetage : ré-ajustez vos prix si besoin."
          />
        </div>
      </div>

      <CurrencyPanel
        currencies={currencies.map((c) => ({
          id: c.id,
          code: c.code,
          name: c.name,
          symbol: c.symbol,
          symbolPosition: c.symbol_position,
          isActive: c.is_active,
          displayOrder: c.display_order,
        }))}
        perms={can}
      />
    </div>
  );
}
