"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { ChevronRight, Loader2, Save } from "lucide-react";

import { saveCheckoutSettingsAction } from "@/lib/actions/checkout-settings";
import { type ActionState } from "@/lib/actions/types";
import {
  FormTabs,
  FormTab,
  TabbedFormError,
  useNoResetSubmit,
  useTabErrorFocus,
  type FormTabDef,
} from "@/components/admin/_components/form-tabs";
import { ToggleField } from "@/components/admin/_components/setting-fields";
import { SelectField } from "@/components/ui/select-field";
import { minorToDinars } from "@/lib/price";

const truthy = (v: string | null | undefined): boolean => {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
};

/**
 * Tabs for the global commerce settings. Each concern (delivery, returns &
 * warranty, order behaviour) is its own tab so they read as distinct global
 * settings — e.g. delivery is configured here, once, never per-product. (Achat
 * express has its own page: Système → Achat express.)
 *
 * All tabs submit together: `FormTabs` keeps hidden panels mounted, so the
 * single `<form>` still posts every key in one `saveCheckoutSettingsAction`
 * call regardless of the active tab.
 */
type SettingsTabId = "delivery" | "returns" | "order";

const SETTINGS_TABS: ReadonlyArray<FormTabDef<SettingsTabId>> = [
  { id: "delivery", label: "Livraison" },
  { id: "returns", label: "Retours & garantie" },
  { id: "order", label: "Commande" },
];
const TAB_LABELS = Object.fromEntries(SETTINGS_TABS.map((t) => [t.id, t.label])) as Record<
  SettingsTabId,
  string
>;
const TAB_ORDER = SETTINGS_TABS.map((t) => t.id);

/** Money field (setting key) → owning tab, so a refused amount jumps to its tab. */
const FIELD_TAB: Record<string, SettingsTabId> = {
  "checkout.delivery.default_fee_cents": "delivery",
  "checkout.delivery.free_threshold_cents": "delivery",
  "checkout.min_order_cents": "order",
};

/**
 * One form, three tabs. Submitting saves every key in a single action call
 * (`saveCheckoutSettingsAction`) so partial-save weirdness is impossible —
 * either everything lands or the user sees a clear error. Payment (COD +
 * online gateways) is configured on Système → Paiement, not here.
 */
export function CheckoutSettingsPanel({
  settings,
}: {
  settings: Record<string, string | null>;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveCheckoutSettingsAction,
    null,
  );
  // Dispatch imperatively so a refused save (e.g. a negative fee) keeps every
  // typed value, and jump to the tab holding the offending amount.
  const onSubmit = useNoResetSubmit(formAction, state);
  const [activeTab, setActiveTab] = useState<SettingsTabId>("delivery");
  const { fieldError } = useTabErrorFocus({
    state,
    fieldTabMap: FIELD_TAB,
    tabOrder: TAB_ORDER,
    setActiveTab,
  });

  return (
    <form action={formAction} onSubmit={onSubmit} className="space-y-6">
      <FormTabs
        tabs={SETTINGS_TABS}
        defaultTab="delivery"
        activeTab={activeTab}
        onActiveTabChange={setActiveTab}
      >
        {(active) => (
          <>
            {/* ─── Livraison ─────────────────────────────────────────────── */}
            <FormTab id="delivery" active={active}>
              <Section
                title="Livraison"
                description="Réglage global de la livraison — frais par défaut, seuil de gratuité, estimation et Click & Collect. Ces valeurs s'appliquent à toute la boutique (jamais par produit)."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <NumberField
                    name="checkout.delivery.default_fee_cents"
                    label="Frais de livraison (TND)"
                    step="0.001"
                    defaultValue={
                      settings["checkout.delivery.default_fee_cents"] != null
                        ? String(minorToDinars(Number(settings["checkout.delivery.default_fee_cents"])))
                        : "7"
                    }
                    helper="0 = livraison toujours offerte. Ex. 7 = 7 TND."
                    error={fieldError("checkout.delivery.default_fee_cents")}
                  />
                  <NumberField
                    name="checkout.delivery.free_threshold_cents"
                    label="Livraison gratuite dès (TND)"
                    step="0.001"
                    defaultValue={
                      settings["checkout.delivery.free_threshold_cents"] != null
                        ? String(minorToDinars(Number(settings["checkout.delivery.free_threshold_cents"])))
                        : "250"
                    }
                    helper="Ex. 250 = 250 TND. Au-dessus, livraison à 0. Sans effet tant que « Livraison gratuite » est désactivée dans Système → Livraison."
                    error={fieldError("checkout.delivery.free_threshold_cents")}
                  />
                </div>
                <Text
                  name="checkout.delivery.eta_label"
                  label="Estimation affichée"
                  defaultValue={settings["checkout.delivery.eta_label"] ?? ""}
                  placeholder="Ex. Livraison 48 h offerte"
                  helper="Affiché sous le prix sur la fiche produit, le panier, ainsi que les badges de confiance en haut des pages catégorie et marque. Laissez vide pour ne rien afficher."
                />
                {/* Structured delivery window — DAY counts (not money). Feeds the
                    estimated delivery date Google shows (Offer deliveryTime). */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <NumberField
                    name="checkout.delivery.handling_days_min"
                    label="Préparation — min (jours)"
                    defaultValue={settings["checkout.delivery.handling_days_min"] ?? "1"}
                    helper="Délai de préparation avant expédition. Sert au délai de livraison estimé affiché par Google."
                  />
                  <NumberField
                    name="checkout.delivery.handling_days_max"
                    label="Préparation — max (jours)"
                    defaultValue={settings["checkout.delivery.handling_days_max"] ?? "3"}
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <NumberField
                    name="checkout.delivery.transit_days_min"
                    label="Transport — min (jours)"
                    defaultValue={settings["checkout.delivery.transit_days_min"] ?? "2"}
                    helper="Durée d'acheminement du transporteur (hors préparation)."
                  />
                  <NumberField
                    name="checkout.delivery.transit_days_max"
                    label="Transport — max (jours)"
                    defaultValue={settings["checkout.delivery.transit_days_max"] ?? "5"}
                  />
                </div>
                <Text
                  name="checkout.delivery.click_collect_label"
                  label="Click & Collect (optionnel)"
                  defaultValue={settings["checkout.delivery.click_collect_label"] ?? ""}
                  helper="Ligne affichée dans l'onglet « Livraison » de la fiche produit. Laissez vide pour ne RIEN afficher (n'annoncez pas un retrait en magasin que vous ne proposez pas)."
                />
              </Section>
            </FormTab>

            {/* ─── Retours & garantie ────────────────────────────────────── */}
            <FormTab id="returns" active={active}>
              <Section
                title="Retours & garantie"
                description="Copie affichée dans l'onglet « Livraison » de la fiche produit et les bandeaux de confiance. Laissez un champ vide pour masquer cette ligne — aucune valeur par défaut n'est affichée."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Text
                    name="checkout.returns.label"
                    label="Retours — résumé"
                    defaultValue={settings["checkout.returns.label"] ?? ""}
                    placeholder="Ex. Retours sous 60 jours"
                    helper="Affiché aussi dans les badges de confiance en haut des pages catégorie et marque. Laissez vide pour ne rien afficher."
                  />
                  <Text
                    name="checkout.warranty.label"
                    label="Garantie — bandeau de confiance"
                    defaultValue={settings["checkout.warranty.label"] ?? ""}
                    placeholder="Ex. Garantie 2 ans"
                    helper="Bandeau marketing statique (page checkout + badges en haut des pages catégorie et marque). Pour la garantie réelle des produits, voir « Garantie produit » ci-dessous. Laissez vide pour ne rien afficher."
                  />
                </div>
                <Text
                  name="checkout.returns.conditions_label"
                  label="Retours — conditions"
                  defaultValue={settings["checkout.returns.conditions_label"] ?? ""}
                  placeholder="Ex. L'article doit être inutilisé et dans son emballage d'origine"
                  helper="Condition affichée sous le résumé des retours. Laissez vide pour ne rien afficher."
                />
                <Text
                  name="checkout.returns.refund_label"
                  label="Retours — remboursement"
                  defaultValue={settings["checkout.returns.refund_label"] ?? ""}
                  placeholder="Ex. Remboursement sous 5 jours ouvrés"
                  helper="Délai de remboursement affiché sur la fiche produit. Laissez vide pour ne rien afficher."
                />
              </Section>
              <Section
                title="Garantie produit — défaut global"
                description="Base de la cascade de garantie (global → catégorie → produit). Appliquée à tout produit qui n'a ni garantie propre ni garantie de catégorie. Affichée sur la fiche produit, et figée sur chaque ligne de commande pour le suivi SAV."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <NumberField
                    name="warranty.default_months"
                    label="Durée par défaut (mois)"
                    defaultValue={settings["warranty.default_months"] ?? ""}
                    helper="Vide ou 0 = aucune garantie par défaut. 12 = 1 an, 24 = 2 ans."
                  />
                  <Text
                    name="warranty.default_label"
                    label="Libellé par défaut (optionnel)"
                    defaultValue={settings["warranty.default_label"] ?? ""}
                    helper="Remplace l'intitulé auto sur la fiche. Un « X » isolé est remplacé par la durée — ex. « Garantie constructeur »."
                  />
                </div>
              </Section>
            </FormTab>

            {/* (Achat express moved to its own page: Système → Achat express.) */}

            {/* ─── Commande ──────────────────────────────────────────────── */}
            <FormTab id="order" active={active}>
              <Section
                title="Comportement commande"
                description="Numérotation des commandes et affichage des prix."
              >
                <Text
                  name="checkout.order.number_prefix"
                  label="Préfixe numéro de commande"
                  defaultValue={settings["checkout.order.number_prefix"] ?? "CMD"}
                  helper="Ex. CMD-7K9P2X. 1-5 caractères majuscules."
                />
                <SelectField
                  name="price.decimals"
                  label="Affichage des prix"
                  defaultValue={settings["price.decimals"] ?? "0"}
                  options={[
                    { value: "0", label: "Dinars entiers — 250 TND" },
                    { value: "3", label: "Millimes — 249,900 TND" },
                  ]}
                  helper="Décimales affichées sur tout le site. Le dinar tunisien se divise en 1000 millimes (pas de centimes)."
                />
              </Section>

              <Section
                title="Règles de commande"
                description="Conditions appliquées AUTORITAIREMENT à la commande (web, achat express et commandes créées par un opérateur)."
              >
                <NumberField
                  name="checkout.min_order_cents"
                  label="Montant minimum de commande (TND)"
                  step="0.001"
                  defaultValue={
                    settings["checkout.min_order_cents"] != null
                      ? String(minorToDinars(Number(settings["checkout.min_order_cents"])))
                      : ""
                  }
                  helper="Vide ou 0 = aucun minimum. Sinon, une commande sous ce montant est refusée."
                  error={fieldError("checkout.min_order_cents")}
                />
                <ToggleField
                  name="checkout.require_account"
                  label="Compte requis pour commander"
                  description="Désactive la commande invité : chaque commande est liée à un compte client."
                  defaultChecked={truthy(settings["checkout.require_account"])}
                />
              </Section>

              <Section
                title="Documents & facturation"
                description="Préfixes des numéros séquentiels (gapless, par année) émis depuis la page d'une commande. La raison sociale + le matricule fiscal s'impriment sur la facture (réglés dans Identité & contact)."
              >
                <div className="grid gap-3 sm:grid-cols-3">
                  <Text
                    name="invoice.number_prefix"
                    label="Préfixe facture"
                    defaultValue={settings["invoice.number_prefix"] ?? "FA"}
                    helper="Ex. FA-2026-000042."
                  />
                  <Text
                    name="invoice.credit_prefix"
                    label="Préfixe avoir"
                    defaultValue={settings["invoice.credit_prefix"] ?? "AV"}
                    helper="Note de crédit. Ex. AV-2026-000007."
                  />
                  <Text
                    name="delivery.note_prefix"
                    label="Préfixe bon de livraison"
                    defaultValue={settings["delivery.note_prefix"] ?? "BL"}
                    helper="Ex. BL-2026-000123."
                  />
                </div>
              </Section>

              <Section
                title="Centre de commande — liens"
                description="Les leviers de la commande sont configurés sur des pages dédiées. État actuel et accès rapide :"
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  <LinkCard href="/admin/system/payments" title="Paiement" hint="Méthodes : COD + passerelles en ligne" />
                  <LinkCard href="/admin/system/express" title="Achat express" hint="Parcours 1-tap « Acheter maintenant »" />
                  <LinkCard href="/admin/system/delivery" title="Livraison" hint="Méthodes, transporteurs, zones régionales" />
                  <LinkCard
                    href="/admin/system/tax"
                    title="Taxes (TVA)"
                    hint={`Mode : ${settings["tax.mode"]?.trim() === "ttc" ? "TTC (incluse)" : settings["tax.mode"]?.trim() === "ht" ? "HT (ajoutée)" : "désactivée"}`}
                  />
                  <LinkCard href="/admin/promotions" title="Promotions & codes" hint="Réductions, coupons, livraison offerte" />
                </div>
              </Section>
            </FormTab>
          </>
        )}
      </FormTabs>

      {/* Feedback + submit */}
      {state && !state.ok && (
        <TabbedFormError
          state={state}
          fieldTabMap={FIELD_TAB}
          tabLabels={TAB_LABELS}
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
          {pending ? "Enregistrement…" : "Enregistrer tous les réglages"}
        </button>
      </div>
    </form>
  );
}

/**
 * Tab-panel section header + body. The surrounding card now comes from
 * `FormTabs` (one card wraps the whole tabbed panel), so this is just a
 * header + spaced content — no nested card.
 */
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <header className="mb-5">
        <h2 className="text-[18px] font-black tracking-[-0.02em] text-foreground">{title}</h2>
        {description && (
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </header>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function LinkCard({ href, title, hint }: { href: string; title: string; hint: string }) {
  return (
    <Link
      href={href}
      className="group flex items-center justify-between gap-2 rounded-[16px] border border-border bg-card px-4 py-3 transition hover:border-primary/40 hover:bg-surface/40"
    >
      <div className="min-w-0">
        <p className="text-sm font-bold text-foreground">{title}</p>
        <p className="truncate text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" />
    </Link>
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
  error,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  helper?: string;
  step?: string;
  /** Field error from the last refused save — shown in place of the helper. */
  error?: string;
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
        aria-invalid={error ? true : undefined}
        className={`mt-2 h-[50px] w-full rounded-[14px] border-[1.5px] bg-[#fbf9f8] px-4 text-[15px] text-foreground tabular-nums placeholder:text-muted-foreground/60 transition focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)] ${
          error ? "border-destructive focus:border-destructive" : "border-input focus:border-foreground"
        }`}
      />
      {error ? (
        <p className="mt-2 text-[11px] font-medium leading-relaxed text-destructive">{error}</p>
      ) : (
        helper && <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{helper}</p>
      )}
    </div>
  );
}
