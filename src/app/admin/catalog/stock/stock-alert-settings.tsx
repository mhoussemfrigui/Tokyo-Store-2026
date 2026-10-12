"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, BellRing } from "lucide-react";

import {
  FieldSection,
  NumberField,
  TextField,
  ToggleField,
} from "@/components/admin/_components/setting-fields";
import { StockReadOnlyBanner } from "./stock-read-only-banner";
import { saveStockAlertSettingsAction } from "@/lib/actions/stock-settings";
import { type LowStockConfig } from "@/lib/inventory/low-stock";
import { type ActionState } from "@/lib/actions/types";

/**
 * "Alertes de stock" card on the global Stock page (L10). Configures the
 * operator low-stock alert: master toggle, the low threshold, and the recipient
 * list. Posts to saveStockAlertSettingsAction, which re-clamps through the SAME
 * resolveLowStockConfig that place-order + the subscriber read. Read-only
 * without stock:update.
 */
export function StockAlertSettings({
  values,
  canManage,
}: {
  values: LowStockConfig;
  canManage: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveStockAlertSettingsAction,
    null,
  );
  // On a successful save, re-read the server so the header pill (seuil N) and the
  // Inventaire tab's « Bas (≤ N) » chip — both derived from the server `values` /
  // lowThreshold props — reflect the new config instead of staying stale until a
  // manual reload. Mirrors InventorySettingsCard.
  const router = useRouter();
  useEffect(() => {
    if (state?.ok) router.refresh();
  }, [state, router]);

  return (
    <form
      action={formAction}
      className="rounded-[28px] border border-border bg-card"
    >
      <div className="flex items-center gap-2 border-b border-border px-6 py-5">
        <BellRing className="h-5 w-5 shrink-0 text-primary" />
        <span className="text-[18px] font-black text-foreground">Alertes de stock</span>
        <span className="truncate text-[12px] text-muted-foreground">
          ·{" "}
          {values.enabled ? `activées · seuil ${values.threshold}` : "désactivées"}
        </span>
      </div>
      <div className="p-6">
      {!canManage && <StockReadOnlyBanner className="mb-4" />}
      <fieldset disabled={!canManage} className="m-0 min-w-0 space-y-6 border-0 p-0">
        <FieldSection
          title="Notifications opérateur"
          description="Quand une VENTE (commande boutique, commande saisie ou modifiée par un opérateur) ou un ajustement de stock via l'API (ERP / caisse) fait passer un produit suivi (quantité non illimitée) sous le seuil — ou à zéro — un email transactionnel part aux responsables. Déclenché une seule fois, au franchissement. Les modifications manuelles de stock dans l'admin ne déclenchent rien."
        >
          <ToggleField
            name="stock.alert_enabled"
            label="Alertes activées"
            description="Désactivé par défaut. Activé : un email part au franchissement du seuil de stock faible et à la rupture."
            defaultChecked={values.enabled}
          />
          <NumberField
            name="stock.low_threshold_qty"
            label="Seuil de stock faible (unités)"
            defaultValue={String(values.threshold)}
            min={0}
            max={100000}
            step={1}
            helper="Une vente (ou un ajustement API) qui amène le stock à ce niveau ou en dessous déclenche l'alerte « stock faible ». 0 = uniquement l'alerte de rupture (stock à 0). Par défaut : 5."
          />
          <TextField
            name="stock.alert_recipients"
            label="Destinataires des alertes"
            defaultValue={values.recipients.join(", ")}
            placeholder="ops@exemple.tn, achats@exemple.tn"
            helper="Adresses séparées par des virgules. Laisser vide : les comptes administrateurs actifs reçoivent les alertes. Max 20."
          />
        </FieldSection>
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
      </div>
    </form>
  );
}
