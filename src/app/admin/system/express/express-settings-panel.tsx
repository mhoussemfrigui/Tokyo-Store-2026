"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Loader2, Zap, CreditCard, ExternalLink, Phone } from "lucide-react";

import { saveExpressSettingsAction } from "@/lib/actions/express-settings";
import { type ActionState } from "@/lib/actions/types";
import { FormTabs, FormTab, type FormTabDef } from "@/components/admin/_components/form-tabs";

const truthy = (v: string | null | undefined): boolean => {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
};

type ExpressTabId = "availability" | "fields" | "payment";
const EXPRESS_TABS: ReadonlyArray<FormTabDef<ExpressTabId>> = [
  { id: "availability", label: "Disponibilité" },
  { id: "fields", label: "Champs du formulaire" },
  { id: "payment", label: "Paiement" },
];

/**
 * The "Achat express" control surface — everything that governs the 1-tap
 * "Acheter maintenant" purchase path, split into sub-tabs: availability (the
 * master switch) and which form fields appear. Payment is NOT configured here:
 * express offers the same methods enabled on the Paiement page and the customer
 * always chooses COD vs an online gateway — the Paiement tab just surfaces that
 * (read-only) and links to where the methods live. Distinct from Réglages
 * commande (full-checkout copy).
 */
export function ExpressSettingsPanel({
  settings,
  enabledMethods,
}: {
  settings: Record<string, string | null>;
  /** COD + the online gateways currently enabled on the Paiement page. */
  enabledMethods: Array<{ value: string; label: string }>;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveExpressSettingsAction,
    null,
  );

  // Express is ON unless explicitly disabled (matches the storefront fallback).
  const expressEnabled =
    truthy(settings["checkout.quick.enabled"]) || settings["checkout.quick.enabled"] == null;

  return (
    <form action={formAction} className="space-y-6">
      <FormTabs tabs={EXPRESS_TABS} defaultTab="availability">
        {(active) => (
          <>
            <FormTab id="availability" active={active}>
              <Section
                title="Disponibilité"
                description="Le bouton « Acheter maintenant » apparaît sur la fiche produit et lance un achat en 1 tap, sans passer par le panier."
              >
                <Toggle
                  name="checkout.quick.enabled"
                  label="Activer l'achat express"
                  description="Décochez pour masquer le bouton « Acheter maintenant » partout (les clients passent alors par le panier)."
                  defaultChecked={expressEnabled}
                />
              </Section>
            </FormTab>

            <FormTab id="fields" active={active}>
              <Section
                title="Champs du formulaire express"
                description="Les champs cochés apparaissent dans le formulaire « Acheter maintenant » (parcours 1 tap sur ordinateur). Plus il y a de champs, plus la conversion ralentit — gardez ça minimal."
              >
                <div className="mb-4 rounded-2xl border border-border bg-surface/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
                  Ces réglages s'appliquent au formulaire <strong>express</strong> (« Acheter
                  maintenant »). Le panier complet (et l'« Acheter » sur mobile, qui y mène)
                  collecte toujours une adresse de livraison complète.
                </div>
                <div className="mb-4 inline-flex items-center gap-2 rounded-2xl border border-border bg-surface/40 px-3 py-2 text-[11px] font-medium text-muted-foreground">
                  <Phone className="h-3.5 w-3.5 text-foreground" strokeWidth={2} />
                  Le <strong className="font-semibold text-foreground">téléphone</strong> est
                  toujours demandé et obligatoire (indispensable pour le COD / la livraison).
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Toggle name="checkout.quick.email_enabled" label="Email" description="Pour envoyer la confirmation. Désactivé par défaut (1 tap)." defaultChecked={truthy(settings["checkout.quick.email_enabled"])} />
                  <Toggle name="checkout.quick.email_required" label="Email — requis" description="Si non, le client peut passer sans." defaultChecked={truthy(settings["checkout.quick.email_required"])} />
                  <Toggle name="checkout.quick.city_enabled" label="Ville" description="Désactivé par défaut. Le rider clarifie au téléphone." defaultChecked={truthy(settings["checkout.quick.city_enabled"])} />
                  <Toggle name="checkout.quick.street_line2_enabled" label="Complément d'adresse" description="Étage, bâtiment, etc." defaultChecked={truthy(settings["checkout.quick.street_line2_enabled"])} />
                  <Toggle name="checkout.quick.region_enabled" label="Gouvernorat" description="Utile pour calculer les frais de livraison." defaultChecked={truthy(settings["checkout.quick.region_enabled"])} />
                  <Toggle name="checkout.quick.postal_code_enabled" label="Code postal" description="Rarement utilisé en Tunisie." defaultChecked={truthy(settings["checkout.quick.postal_code_enabled"])} />
                  <Toggle name="checkout.quick.notes_enabled" label="Notes" description="Champ libre (instructions de livraison)." defaultChecked={truthy(settings["checkout.quick.notes_enabled"])} />
                </div>
              </Section>
            </FormTab>

            <FormTab id="payment" active={active}>
              <Section
                title="Paiement de l'achat express"
                description="L'achat express n'a pas de configuration de paiement séparée : il propose les mêmes moyens de paiement que le panier, et le client choisit librement entre le paiement à la livraison (COD) et le paiement en ligne."
              >
                <div className="rounded-2xl border border-border bg-surface/40 p-4">
                  <p className="mb-2 inline-flex items-center gap-2 text-xs font-semibold text-foreground">
                    <CreditCard className="h-4 w-4" /> Moyens de paiement actuellement autorisés
                  </p>
                  {enabledMethods.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {enabledMethods.map((m) => (
                        <span
                          key={m.value}
                          className="inline-flex items-center rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-foreground"
                        >
                          {m.label}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-destructive">
                      Aucun moyen de paiement activé — activez au moins le COD ou une passerelle
                      sur la page Paiement, sinon l'achat express ne peut pas aboutir.
                    </p>
                  )}
                  <Link
                    href="/admin/system/payments"
                    className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
                  >
                    Configurer les moyens de paiement <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </Section>
            </FormTab>
          </>
        )}
      </FormTabs>

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
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
          {pending ? "Enregistrement…" : "Enregistrer l'achat express"}
        </button>
      </div>
    </form>
  );
}

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
