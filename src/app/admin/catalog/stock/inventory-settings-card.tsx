"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MapPin, Save } from "lucide-react";

import { SelectField, ToggleField } from "@/components/admin/_components/setting-fields";
import { StockReadOnlyBanner } from "./stock-read-only-banner";
import { saveInventorySettingsAction } from "@/lib/actions/stock-locations";
import {
  INVENTORY_CARRIER_LINK_KEY,
  INVENTORY_LOCATION_MODE_KEY,
  INVENTORY_TRANSFERS_KEY,
  INVENTORY_TRANSFER_AUTO_KEY,
  INVENTORY_TRANSFER_SOURCING_KEY,
  INVENTORY_WEB_STOCK_SOURCE_KEY,
  type InventoryConfig,
} from "@/lib/inventory/locations-config";
import { type ActionState } from "@/lib/actions/types";

/**
 * The `inventory.*` settings form — the multi-location MODE + carrier link, and
 * the transfer flags (enabled, auto-request, sourcing strategy). Lives in the
 * Stock → Réglages tab (moved out of the Emplacements card, which is now the
 * locations CRUD only). Posts to saveInventorySettingsAction. Read-only without
 * stock:update.
 */
export function InventorySettingsCard({
  canManage,
  config,
}: {
  canManage: boolean;
  config: InventoryConfig;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveInventorySettingsAction,
    null,
  );
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        // Switching the stock-tracking MODE is consequential (it changes the
        // whole Stock table + redistributes stock onto the default location), so
        // confirm before saving when the mode actually changes. The other toggles
        // are minor feature flags and save without a prompt.
        const nextMode = new FormData(e.currentTarget).get(INVENTORY_LOCATION_MODE_KEY);
        if (nextMode !== config.locationMode) {
          const msg =
            nextMode === "per_location"
              ? "Activer le suivi du stock PAR EMPLACEMENT ?\n\nLe tableau Stock affichera une colonne par emplacement et le stock actuel sera réparti sur l'emplacement par défaut (les produits non suivis restent non suivis)."
              : "Revenir au stock PARTAGÉ (pool unique) ?\n\nLes colonnes par emplacement seront masquées ; les totaux de stock actuels restent inchangés.";
          if (!window.confirm(msg)) e.preventDefault();
        }
      }}
      className="rounded-[28px] border border-border bg-card p-6"
    >
      <div className="mb-5 flex items-center gap-2">
        <MapPin className="h-5 w-5 text-primary" />
        <h2 className="text-[18px] font-black text-foreground">Emplacements & transferts</h2>
      </div>

      {!canManage && <StockReadOnlyBanner className="mb-4" />}

      <fieldset disabled={!canManage} className="m-0 min-w-0 space-y-4 border-0 p-0">
        <SelectField
          name={INVENTORY_LOCATION_MODE_KEY}
          label="Mode de suivi du stock"
          defaultValue={config.locationMode}
          options={[
            { value: "shared", label: "Partagé — un seul pool (par défaut)" },
            { value: "per_location", label: "Par emplacement — stock suivi par magasin" },
          ]}
          helper="« Partagé » : les emplacements sont organisationnels, le stock reste un pool unique. « Par emplacement » : le tableau Stock affiche une colonne de quantité par emplacement actif."
        />
        <SelectField
          name={INVENTORY_WEB_STOCK_SOURCE_KEY}
          label="Stock vendu en ligne (site web)"
          defaultValue={config.webStockSource}
          options={[
            { value: "central", label: "Centrale (dépôt web) — expédie depuis la Centrale + réappro auto" },
            { value: "combined", label: "Combiné — tous les emplacements à parts égales" },
          ]}
          helper="S'applique en mode « par emplacement ». « Centrale » : le site web expédie depuis l'emplacement Centrale et, s'il est à court, un transfert boutique→Centrale le réapprovisionne automatiquement. « Combiné » : les emplacements sont des pools pairs, sans dépôt dédié ni réappro auto. Dans les deux cas le stock vendable en ligne reste la somme de tous les emplacements actifs — aucun stock boutique n'est masqué."
        />
        <ToggleField
          name={INVENTORY_CARRIER_LINK_KEY}
          label="Lier les emplacements à la livraison"
          description="Permet d'associer chaque emplacement à un transporteur ou point de retrait (Livraison → Transporteurs & points). Facultatif et informatif pour l'instant : l'attribution des commandes à un emplacement arrive dans une phase ultérieure. Désactiver cette option conserve les liaisons existantes."
          defaultChecked={config.carrierLinkEnabled}
        />
        <ToggleField
          name={INVENTORY_TRANSFERS_KEY}
          label="Transferts entre emplacements"
          description="Active l'onglet Transferts et les scénarios de réapprovisionnement (par ex. depuis une autre boutique vers le dépôt qui vend en ligne)."
          defaultChecked={config.transfersEnabled}
        />
        <ToggleField
          name={INVENTORY_TRANSFER_AUTO_KEY}
          label="Demande de transfert automatique"
          description="À une commande que le dépôt ne peut pas honorer, une demande de transfert depuis une boutique est créée automatiquement dès la validation de la commande. Désactivé : les transferts sont demandés manuellement."
          defaultChecked={config.transferAutoRequest}
        />
        <SelectField
          name={INVENTORY_TRANSFER_SOURCING_KEY}
          label="Stratégie de source des transferts"
          defaultValue={config.transferSourcing}
          options={[
            { value: "priority", label: "Priorité — dans l'ordre d'affichage des emplacements" },
            { value: "most_stock", label: "Plus grand stock — la boutique qui en a le plus d'abord" },
          ]}
          helper="Quelle boutique servir en premier pour une demande automatique lorsque plusieurs ont l'article."
        />
      </fieldset>

      {state && !state.ok && <p className="mt-4 text-[14px] text-destructive">{state.message}</p>}
      {state?.ok && <p className="mt-4 text-[14px] text-[#15803d]">{state.message}</p>}

      {canManage && (
        <div className="mt-6 flex justify-end">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Enregistrer
          </button>
        </div>
      )}
    </form>
  );
}
