"use client";

import { useActionState } from "react";
import { Loader2, Save } from "lucide-react";

import { saveTaxSettingsAction } from "@/lib/actions/tax-settings";
import { type ActionState } from "@/lib/actions/types";
import { SelectField } from "@/components/ui/select-field";
import {
  TAX_SETTING_KEYS,
  CARE_TAX_SETTING_KEYS,
  type TaxConfig,
  type CareTaxConfig,
  percentFromBps,
} from "@/lib/tax/shared";

/**
 * Global tax (TVA) config panel — the BASE of the cascade
 * (produit → filtre → marque → catégorie → global). Mirrors the checkout-settings
 * panel: one `<form>`, posts every key in a single `saveTaxSettingsAction`.
 *
 * The admin enters the default rate as a PERCENT; the action converts to bps.
 */
export function TaxSettingsPanel({
  config,
  careTax,
}: {
  config: TaxConfig;
  careTax: CareTaxConfig;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveTaxSettingsAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-6">
      <div>
        <header className="mb-5">
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">
            Réglage global de la TVA
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            Le mode et le taux par défaut s&apos;appliquent à toute la boutique. Le
            taux peut être surchargé par produit, filtre, marque ou catégorie — voir
            l&apos;ordre de priorité plus bas.
          </p>
        </header>

        <div className="space-y-4">
          <SelectField
            name={TAX_SETTING_KEYS.mode}
            label="Mode de taxation"
            defaultValue={config.mode}
            options={[
              {
                value: "disabled",
                label: "Désactivé",
                description: "Aucune taxe calculée ni affichée.",
              },
              {
                value: "ttc",
                label: "TTC — prix taxe comprise",
                description: "La taxe est extraite du prix (« dont TVA »). Le total ne change pas.",
              },
              {
                value: "ht",
                label: "HT — prix hors taxe",
                description: "La taxe est ajoutée au total à la commande.",
              },
            ]}
            helper="Désactivé par défaut. Activez TTC ou HT pour calculer la taxe."
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              name={TAX_SETTING_KEYS.defaultRateBps}
              label="Taux par défaut (%)"
              step="0.01"
              defaultValue={String(percentFromBps(config.defaultRateBps))}
              helper="Ex. 19 = 19 % (vide = 19 % par défaut). Utilisé quand aucun produit, filtre, marque ou catégorie ne fixe de taux."
            />
            <Text
              name={TAX_SETTING_KEYS.label}
              label="Libellé affiché"
              defaultValue={config.label}
              placeholder="TVA"
              helper="Apparaît sur la commande (« dont TVA 19 % »). Laissez vide pour « TVA »."
            />
          </div>

          <Toggle
            name={TAX_SETTING_KEYS.onShipping}
            label="Taxer aussi les frais de livraison"
            description="Si activé, la taxe s'applique également au montant de la livraison."
            defaultChecked={config.onShipping}
          />
        </div>
      </div>

      {/* ── TVA Tokyo Care (service de garantie bonus) ── */}
      <div className="border-t border-border pt-6">
        <header className="mb-5">
          <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">TVA — Tokyo Care</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            Taxe appliquée au service de protection Tokyo Care, indépendamment des produits.
            Le mode de taxation global ci-dessus s&apos;applique (désactivé = aucune TVA Tokyo Care).
          </p>
        </header>
        <div className="space-y-4">
          <Toggle
            name={CARE_TAX_SETTING_KEYS.taxable}
            label="Taxer le service Tokyo Care"
            description="Décochez pour exonérer la garantie bonus de TVA, même si la boutique applique la TVA."
            defaultChecked={careTax.taxable}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField
              name={CARE_TAX_SETTING_KEYS.rateBps}
              label="Taux TVA Tokyo Care (%)"
              step="0.01"
              defaultValue={String(percentFromBps(careTax.rateBps))}
              helper="Ex. 19 = 19 % (vide = taux par défaut de la boutique)."
            />
            <Text
              name={CARE_TAX_SETTING_KEYS.label}
              label="Libellé TVA Tokyo Care"
              defaultValue={careTax.label}
              placeholder="TVA"
              helper="Laissez vide pour « TVA »."
            />
          </div>
        </div>
      </div>

      {/* Feedback + submit */}
      {state && !state.ok && (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
          {state.message}
        </div>
      )}
      {state?.ok && (
        <div className="rounded-[16px] border border-[#cdebd6] bg-[#eaf7ee] p-3 text-xs font-semibold text-[#15803d]">
          {state.message}
        </div>
      )}

      <div className="sticky bottom-4 z-10 flex items-center justify-end">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground shadow-lift transition hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {pending ? "Enregistrement…" : "Enregistrer le réglage global"}
        </button>
      </div>
    </form>
  );
}

function Toggle({
  name,
  label,
  description,
  defaultChecked,
}: {
  name: string;
  label: string;
  description?: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3.5 rounded-2xl border border-border bg-card px-4 py-3.5 transition hover:bg-surface/40 has-[:checked]:border-primary/40 has-[:checked]:bg-primary/5">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-[3px] h-4 w-4 shrink-0 accent-[var(--primary)]"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-semibold leading-tight text-foreground">{label}</p>
        {description && (
          <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
    </label>
  );
}

function Text({
  name,
  label,
  defaultValue,
  placeholder,
  helper,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  helper?: string;
}) {
  const id = `f-${name.replace(/\./g, "-")}`;
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-[13px] font-bold text-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        name={name}
        type="text"
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="mt-2 h-[50px] w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] text-foreground placeholder:text-muted-foreground/60 transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]"
      />
      {helper && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>}
    </div>
  );
}

function NumberField({
  name,
  label,
  defaultValue,
  helper,
  step,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  helper?: string;
  step?: string;
}) {
  const id = `f-${name.replace(/\./g, "-")}`;
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-[13px] font-bold text-foreground"
      >
        {label}
      </label>
      <input
        id={id}
        name={name}
        type="number"
        min={0}
        step={step}
        inputMode={step ? "decimal" : "numeric"}
        defaultValue={defaultValue}
        className="mt-2 h-[50px] w-full rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 text-[15px] text-foreground tabular-nums placeholder:text-muted-foreground/60 transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]"
      />
      {helper && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>}
    </div>
  );
}
