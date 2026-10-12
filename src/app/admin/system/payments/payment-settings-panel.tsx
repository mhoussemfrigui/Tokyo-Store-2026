"use client";

import { useActionState, useState } from "react";
import { AlertTriangle, Check, Loader2, Lock, Save, X } from "lucide-react";

import { savePaymentSettingsAction } from "@/lib/actions/payment-settings";
import { providerSupportsTestMode } from "@/lib/payments/shared";
import { type ActionState } from "@/lib/actions/types";
import {
  FormTabs,
  FormTab,
  TabbedFormError,
  useTabErrorFocus,
} from "@/components/admin/_components/form-tabs";
import {
  FieldSection,
  SecretField,
  TextField,
  ToggleField,
} from "@/components/admin/_components/setting-fields";

export type ProviderField = {
  key: string;
  label: string;
  name: string;
  hasValue: boolean;
  locked: boolean;
  envVar: string;
};

export type ProviderTabData = {
  provider: "clictopay" | "flouci";
  label: string;
  enabled: boolean;
  testMode: boolean;
  testModeLocked: boolean;
  fields: ProviderField[];
};

/** COD method config (cod_enabled / cod_label). This page owns payment METHODS
 *  only — the single allowed-methods set shared by the cart and the express
 *  flows; express has no payment routing of its own (the customer chooses). */
export type CodData = {
  codEnabled: boolean;
  codLabel: string;
  /** « Paiement manuel » — lets operators set an order Payée/Partielle/Non payée. */
  manualPaymentEnabled: boolean;
};

const BLURB: Record<string, string> = {
  clictopay:
    "Carte bancaire — Monétique Tunisie (SMT). Identifiants marchands fournis par votre banque.",
  flouci: "Carte bancaire. App token + secret depuis developers.flouci.com.",
};

/** Where to obtain each provider's credentials (shown under the tab title). */
const DASHBOARD: Record<string, { href: string; label: string } | null> = {
  clictopay: null, // bank-provided, no public dashboard
  flouci: { href: "https://developers.flouci.com", label: "developers.flouci.com" },
};

/** A gateway is "ready" only when it's enabled AND has resolvable credentials. */
function gatewayCredsPresent(p: ProviderTabData): boolean {
  return p.fields.every((f) => f.hasValue);
}

/** Shown on the owner-only fields (credentials + sandbox) for a non-`*` actor. */
const OWNER_ONLY_NOTE =
  "Identifiants marchands et mode sandbox réservés au super-administrateur : ils décident sur quel compte les paiements sont encaissés. Vous pouvez activer / désactiver la passerelle.";

/**
 * Payment METHODS configuration. A per-method status strip up top (enabled /
 * credentials / sandbox at a glance), then COD first (the default method) +
 * one tab per online gateway. Credentials are write-only (never sent back —
 * an empty field keeps the stored value). Env-locked fields are disabled, and
 * so are the credentials + sandbox toggle for a non-super-admin (the action
 * refuses them server-side). A gateway the save could not enable (incomplete
 * credentials) is reported with a link to its tab.
 */
export function PaymentSettingsPanel({
  providers,
  cod,
  canEditCredentials,
}: {
  providers: ProviderTabData[];
  cod: CodData;
  canEditCredentials: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    savePaymentSettingsAction,
    null,
  );

  // COD first (the default + most-used method), then the online gateways.
  const COD_TAB = "cod";
  const tabs = [
    { id: COD_TAB, label: "Paiement à la livraison" },
    ...providers.map((p) => ({ id: p.provider, label: p.label })),
  ];
  const tabLabels = Object.fromEntries(tabs.map((t) => [t.id, t.label]));
  // A refused gateway enable is keyed by its toggle's input name → its tab.
  const fieldTab = Object.fromEntries(
    providers.map((p) => [`checkout.payment.${p.provider}_enabled`, p.provider as string]),
  );
  const [activeTab, setActiveTab] = useState<string>(COD_TAB);
  useTabErrorFocus({
    state,
    fieldTabMap: fieldTab,
    tabOrder: tabs.map((t) => t.id),
    setActiveTab,
  });

  return (
    <form action={formAction} className="space-y-6">
      {/* ── Per-method status overview ──────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatusCard label="À la livraison" enabled={cod.codEnabled} />
        {providers.map((p) => {
          const ready = p.enabled && gatewayCredsPresent(p);
          return (
            <StatusCard
              key={p.provider}
              label={p.label}
              enabled={ready}
              note={
                !p.enabled
                  ? "désactivé"
                  : !gatewayCredsPresent(p)
                    ? "clés manquantes"
                    : providerSupportsTestMode(p.provider) && p.testMode
                      ? "sandbox"
                      : "production"
              }
              warn={p.enabled && p.testMode && providerSupportsTestMode(p.provider)}
            />
          );
        })}
      </div>

      <FormTabs
        tabs={tabs}
        defaultTab={COD_TAB}
        activeTab={activeTab}
        onActiveTabChange={setActiveTab}
      >
        {(active) => (
          <>
            {/* ─── Paiement à la livraison (COD) ───────────────────────── */}
            <FormTab id={COD_TAB} active={active}>
              <FieldSection
                title="Paiement à la livraison (COD)"
                description="Le mode hors-ligne par défaut : le client paie en espèces à la réception. Le routage de l'achat express se configure sur la page « Achat express »."
              >
                <ToggleField
                  name="checkout.quick.cod_enabled"
                  label="Activer le paiement à la livraison"
                  description="Désactivez si vous ne livrez plus sans paiement préalable."
                  defaultChecked={cod.codEnabled}
                />
                <TextField
                  name="checkout.quick.cod_label"
                  label="Libellé affiché"
                  defaultValue={cod.codLabel}
                  placeholder="Ex. Paiement à la livraison"
                  helper="Affiché en option de paiement. Laissez vide pour « Paiement à la livraison »."
                />
              </FieldSection>

              {/* ─── Paiement manuel des commandes ───────────────────────── */}
              <FieldSection
                title="Paiement manuel des commandes"
                description="Pour les règlements hors-ligne (espèces, virement, acompte) que la passerelle ne voit pas."
              >
                <ToggleField
                  name="orders.manual_payment_enabled"
                  label="Autoriser la modification manuelle du paiement"
                  description="Ajoute un contrôle sur la fiche commande pour marquer une commande « Payée », « Partiellement payée » (avec le montant reçu) ou « Non payée ». Marquer « Payée » enregistre le règlement comme un paiement réel (chiffre d'affaires)."
                  defaultChecked={cod.manualPaymentEnabled}
                />
              </FieldSection>
            </FormTab>

            {providers.map((p) => (
              <FormTab key={p.provider} id={p.provider} active={active}>
                <FieldSection title={`${p.label} — configuration`} description={BLURB[p.provider]}>
                  {DASHBOARD[p.provider] && (
                    <p className="text-[11px] text-muted-foreground">
                      Clés :{" "}
                      <a
                        href={DASHBOARD[p.provider]!.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary underline"
                      >
                        {DASHBOARD[p.provider]!.label}
                      </a>
                    </p>
                  )}
                  <ToggleField
                    name={`checkout.payment.${p.provider}_enabled`}
                    label={`Activer ${p.label} au paiement`}
                    description="Affiche cette passerelle au paiement (uniquement si toutes les clés sont présentes)."
                    defaultChecked={p.enabled}
                  />
                  {!canEditCredentials && (
                    <div className="flex items-start gap-2 rounded-[16px] border border-[#f3e3bd] bg-[#fff4e0] p-3 text-[11px] leading-relaxed text-muted-foreground">
                      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#b45309]" />
                      <span>{OWNER_ONLY_NOTE}</span>
                    </div>
                  )}
                  {providerSupportsTestMode(p.provider) ? (
                    <>
                      <ToggleField
                        name={`test_mode.${p.provider}`}
                        label="Mode sandbox (test)"
                        description="Coché = environnement de test du prestataire. Décochez pour encaisser en production."
                        defaultChecked={p.testMode}
                        disabled={p.testModeLocked || !canEditCredentials}
                        locked={p.testModeLocked}
                      />
                      {p.enabled && p.testMode && (
                        <div className="flex items-start gap-2 rounded-[16px] border border-[#f3e3bd] bg-[#fff4e0] p-3 text-[11px] leading-relaxed text-[#b45309]">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>
                            <strong>{p.label} est activé en mode sandbox.</strong> Les paiements ne
                            sont PAS réels. Décochez « Mode sandbox » pour encaisser en production.
                          </span>
                        </div>
                      )}
                    </>
                  ) : (
                    // Provider with no sandbox host (e.g. Flouci v2): test vs live
                    // is decided by WHICH credentials you enter, so there's no
                    // toggle to show — surfacing one would falsely imply test mode.
                    <p className="rounded-[16px] border border-border bg-[#fbf9f8] p-3 text-[11px] leading-relaxed text-muted-foreground">
                      L&apos;environnement (test ou production) est déterminé par les identifiants
                      saisis : utilisez vos clés de test pour tester, vos clés de production pour
                      encaisser réellement. {p.label} ne propose pas de bascule sandbox distincte.
                    </p>
                  )}
                  {/* Disabled (posts nothing) for a non-super-admin. */}
                  <fieldset disabled={!canEditCredentials} className="min-w-0 space-y-4">
                    {p.fields.map((f) => (
                      <SecretField
                        key={f.key}
                        name={f.name}
                        label={f.label}
                        hasValue={f.hasValue}
                        locked={f.locked}
                        helper={`Variable d'environnement (prioritaire) : ${f.envVar}`}
                      />
                    ))}
                  </fieldset>
                </FieldSection>
              </FormTab>
            ))}
          </>
        )}
      </FormTabs>

      {state && !state.ok && (
        <TabbedFormError
          state={state}
          fieldTabMap={fieldTab}
          tabLabels={tabLabels}
          onJumpToTab={setActiveTab}
        />
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
          {pending ? "Enregistrement…" : "Enregistrer la configuration"}
        </button>
      </div>
    </form>
  );
}

/** One method's at-a-glance status chip in the overview strip. */
function StatusCard({
  label,
  enabled,
  note,
  warn,
}: {
  label: string;
  enabled: boolean;
  note?: string;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-[16px] border p-3 ${
        warn
          ? "border-[#f3e3bd] bg-[#fff4e0]"
          : enabled
            ? "border-[#cdebd6] bg-[#eaf7ee]"
            : "border-border bg-surface/40"
      }`}
    >
      <div className="flex items-center justify-between gap-1">
        <span className="truncate text-xs font-bold text-foreground">{label}</span>
        {enabled ? (
          <Check className={`h-3.5 w-3.5 shrink-0 ${warn ? "text-[#b45309]" : "text-[#15803d]"}`} />
        ) : (
          <X className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
      </div>
      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-[#8a857f]">
        {note ?? (enabled ? "activé" : "désactivé")}
      </p>
    </div>
  );
}
