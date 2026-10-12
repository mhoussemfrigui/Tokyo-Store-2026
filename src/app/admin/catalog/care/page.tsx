import type { Metadata } from "next";
import Link from "next/link";
import { Plus, ShieldCheck } from "lucide-react";

import { careService } from "@/modules/catalog/care/service";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { resolveCareConfig } from "@/lib/care/config";
import { minorToDinars } from "@/lib/price";
import { carePlanPriceSummary } from "@/lib/care/display";
import { CareSettingsForm } from "@/components/admin/care-settings-form";
import { AdminCallout, AdminNote } from "@/components/admin/_components/filter-bar";

export const metadata: Metadata = { title: "Tokyo Care" };

export default async function CareAdminPage() {
  const session = await requirePermission("care", "view");
  const perms = await resolveUserPermissions(session.user.id);
  const canCreate = permissionSetAllows(perms, "care", "create");
  const canUpdate = permissionSetAllows(perms, "care", "update");

  const [plans, cfg] = await Promise.all([careService.listAll(), resolveCareConfig()]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <div>
          <AdminNote className="max-w-3xl">
            Plans de garantie bonus (protection) vendus en option sur les produits éligibles. Tout est
            paramétrable ici : tarif, durée, éligibilité, couverture, et activation par catégorie ou
            produit. La TVA du service se règle dans Système → Taxes.
          </AdminNote>
        </div>
        {canCreate && (
          <Link
            href="/admin/catalog/care/new"
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a]"
          >
            <Plus className="size-4" aria-hidden /> Nouveau plan
          </Link>
        )}
      </header>

      {!cfg.enabled && (
        <AdminCallout tone="warning">
          Tokyo Care est <strong>désactivé</strong> — les plans ne sont pas proposés aux clients ni
          facturés tant que l&apos;interrupteur principal ci-dessous est éteint.
        </AdminCallout>
      )}

      {canUpdate && (
        <CareSettingsForm
          enabled={cfg.enabled}
          chargePerUnit={cfg.chargePerUnit}
          countsTowardFreeShipping={cfg.countsTowardFreeShipping}
        />
      )}

      {plans.length === 0 ? (
        <div className="rounded-[16px] border border-dashed border-border bg-card p-10 text-center">
          <ShieldCheck className="mx-auto size-8 text-muted-foreground" aria-hidden />
          <p className="mt-3 text-[15px] font-bold text-foreground">Aucun plan Tokyo Care pour le moment.</p>
          <p className="mt-1 text-[14px] text-muted-foreground">
            Créez un premier plan pour proposer une protection sur vos produits.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-[22px] border border-border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-[#fbf9f8] text-left text-[12px] font-bold uppercase tracking-[0.06em] text-[#8a857f]">
              <tr>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Tarif</th>
                <th className="px-4 py-3">Durée</th>
                <th className="px-4 py-3">Éligibilité</th>
                <th className="px-4 py-3">Statut</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {plans.map((p) => (
                <tr key={p.id} className="hover:bg-[#fffbfb]">
                  <td className="px-4 py-3">
                    <div className="text-[14px] font-bold text-foreground">{p.name}</div>
                    <div className="text-[12px] text-muted-foreground">/{p.slug}</div>
                  </td>
                  <td className="px-4 py-3 text-[14px] tabular-nums text-foreground">{carePlanPriceSummary(p)}</td>
                  <td className="px-4 py-3 text-[14px] text-foreground">{p.duration_months} mois</td>
                  <td className="px-4 py-3 text-[12px] text-muted-foreground">
                    {p.require_warranty ? "Produits garantis" : "Tous produits"}
                    {p.min_product_price_cents > 0 &&
                      ` · ≥ ${minorToDinars(p.min_product_price_cents).toLocaleString("fr-TN")} TND`}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        p.is_active
                          ? "inline-flex items-center gap-1.5 rounded-full border border-[#cdebd6] bg-[#eaf7ee] px-2.5 py-1 text-[11px] font-bold text-[#15803d]"
                          : "inline-flex items-center gap-1.5 rounded-full bg-[#f6f2ed] px-2.5 py-1 text-[11px] font-bold text-[#5b5d62]"
                      }
                    >
                      {p.is_active ? "Actif" : "Brouillon"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {canUpdate && (
                      <Link
                        href={`/admin/catalog/care/${p.id}`}
                        className="text-[14px] font-bold text-primary hover:underline"
                      >
                        Éditer
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
