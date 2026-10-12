import { Layers } from "lucide-react";

import { AdminNote } from "@/components/admin/_components/filter-bar";
import { type LowStockConfig } from "@/lib/inventory/low-stock";
import { type InventoryConfig } from "@/lib/inventory/locations-config";
import { SharedStockToggle } from "./shared-stock-toggle";
import { InventorySettingsCard } from "./inventory-settings-card";
import { StockAlertSettings } from "./stock-alert-settings";

/**
 * "Réglages" — the single hub for every STOCK setting, gathered from where they
 * used to live scattered (the variant-mode toggle off the Inventaire header, the
 * Alertes tab, the multi-stock settings inside the Emplacements card). Composes
 * the existing self-contained settings surfaces; each keeps its own save.
 */
export function ReglagesPanel({
  canManage,
  sharedStockDefault,
  lowStock,
  inventory,
}: {
  canManage: boolean;
  sharedStockDefault: boolean;
  lowStock: LowStockConfig;
  inventory: InventoryConfig;
}) {
  return (
    <div className="space-y-6">
      {/* Variantes — the global default stock mode for variable products. */}
      <section className="rounded-[28px] border border-border bg-card p-6">
        <div className="mb-3 flex items-center gap-2">
          <Layers className="h-5 w-5 text-primary" />
          <h2 className="text-[18px] font-black text-foreground">Stock des variantes</h2>
        </div>
        <AdminNote className="max-w-2xl">
          Mode de stock par défaut des produits variables. « Partagé » : toutes les variantes
          puisent dans un seul pool ; « par variante » : chacune suit son propre stock. Chaque
          produit peut surcharger ce réglage.
        </AdminNote>
        <div className="mt-4">
          <SharedStockToggle initial={sharedStockDefault} disabled={!canManage} />
        </div>
      </section>

      {/* Emplacements & transferts — mode, carrier link, transfer flags. */}
      <InventorySettingsCard canManage={canManage} config={inventory} />

      {/* Alertes de stock faible. */}
      <StockAlertSettings values={lowStock} canManage={canManage} />
    </div>
  );
}
