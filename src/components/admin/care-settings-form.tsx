"use client";

import { useActionState } from "react";

import { saveCareSettingsAction } from "@/lib/actions/care";
import { CARE_SETTING_KEYS } from "@/lib/care/keys";
import type { ActionState } from "@/lib/actions/types";

/**
 * Store-wide Tokyo Care switches (the "Réglages" panel on the Tokyo Care tab).
 * `enabled` is the master kill-switch — until it is on, no plan is offered on the
 * storefront and nothing is charged. The two charging knobs mirror the server
 * charge path (per-unit vs per-line; whether the fee counts toward free shipping).
 */
export function CareSettingsForm({
  enabled,
  chargePerUnit,
  countsTowardFreeShipping,
}: {
  enabled: boolean;
  chargePerUnit: boolean;
  countsTowardFreeShipping: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    saveCareSettingsAction,
    null,
  );

  const row = (key: string, label: string, hint: string, defaultChecked: boolean) => (
    <label className="flex items-start gap-3 py-2">
      <input
        type="checkbox"
        name={key}
        defaultChecked={defaultChecked}
        className="mt-0.5 size-4 rounded border-input accent-[var(--primary)]"
      />
      <span>
        <span className="block text-[14px] font-bold text-foreground">{label}</span>
        <span className="block text-[12px] text-muted-foreground">{hint}</span>
      </span>
    </label>
  );

  return (
    <form action={action} className="rounded-[28px] border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-[18px] font-black text-foreground">Réglages Tokyo Care</h2>
        {state && (
          <span className={state.ok ? "text-[12px] font-bold text-[#15803d]" : "text-[12px] font-bold text-[#d40530]"}>
            {state.message}
          </span>
        )}
      </div>
      <div className="mt-3 divide-y divide-border">
        {row(
          CARE_SETTING_KEYS.enabled,
          "Activer Tokyo Care",
          "Interrupteur principal. Tant qu'il est éteint, aucun plan n'est proposé ni facturé.",
          enabled,
        )}
        {row(
          CARE_SETTING_KEYS.chargePerUnit,
          "Facturer par unité",
          "Multiplie le tarif du plan par la quantité de la ligne (sinon : une fois par ligne).",
          chargePerUnit,
        )}
        {row(
          CARE_SETTING_KEYS.countsTowardFreeShipping,
          "Compter dans la livraison gratuite",
          "Inclure le montant Tokyo Care dans le seuil de franco de port (par défaut : non).",
          countsTowardFreeShipping,
        )}
      </div>
      <div className="mt-4">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? "Enregistrement…" : "Enregistrer les réglages"}
        </button>
      </div>
    </form>
  );
}
