"use client";

import Link from "next/link";
import { useActionState } from "react";
import { AlertTriangle, Loader2, Save } from "lucide-react";

import {
  FieldSection,
  NumberField,
  TextField,
  ToggleField,
} from "@/components/admin/_components/setting-fields";
import { saveCookieSettingsAction } from "@/lib/actions/cookies";
import { type ActionState } from "@/lib/actions/types";

type Values = {
  enabled: boolean;
  title: string;
  description: string;
  policyUrl: string;
  privacyUrl: string;
  functionalEnabled: boolean;
  analyticsEnabled: boolean;
  marketingEnabled: boolean;
  revision: string;
  /** Cross-tab: « Bypass » is ON in Suivi & Analytics → this banner is ignored. */
  bypassActive: boolean;
};

function Textarea({
  name,
  label,
  defaultValue,
  placeholder,
  rows = 3,
}: {
  name: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[13px] font-bold text-foreground">{label}</span>
      <textarea
        name={name}
        defaultValue={defaultValue}
        placeholder={placeholder}
        rows={rows}
        className="w-full resize-y rounded-[14px] border-[1.5px] border-input bg-[#fbf9f8] px-4 py-3 text-[15px] text-foreground placeholder:text-muted-foreground/60 transition focus:border-foreground focus:bg-white focus:outline-none focus:ring-[3px] focus:ring-[rgba(14,18,24,0.07)]"
      />
    </label>
  );
}

export function CookieSettingsPanel({ values }: { values: Values }) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveCookieSettingsAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="max-w-3xl text-[14px] leading-relaxed text-muted-foreground">
            Bannière de consentement (RGPD / ePrivacy) : activez-la, personnalisez le texte et
            choisissez les catégories proposées au visiteur. Ces catégories pilotent les balises
            configurées dans{" "}
            <Link href="/admin/system/analytics" className="font-medium text-primary hover:underline">
              Système → Suivi &amp; Analytics
            </Link>{" "}
            (les deux onglets sont liés) : une catégorie désactivée ici n'est jamais accordée, même
            pour un visiteur qui l'avait déjà acceptée.
          </p>
        </div>
      </header>

      {values.bypassActive && (
        <div className="flex items-start gap-3 rounded-[16px] border border-[#f3e3bd] bg-[#fff4e0] px-4 py-3.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]" strokeWidth={2} />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Le <span className="font-medium text-foreground">bypass</span> est actif dans{" "}
            <Link href="/admin/system/analytics" className="text-primary hover:underline">
              Suivi &amp; Analytics
            </Link>{" "}
            : cette bannière est <span className="font-medium text-foreground">ignorée</span> et le
            suivi collecte pour tous les visiteurs, quels que soient les réglages ci-dessous.
          </p>
        </div>
      )}

      <FieldSection
        title="Bannière de consentement"
        description="Le commutateur maître. Désactivée = aucune bannière et les balises tierces se chargent normalement (vous assumez alors la conformité)."
      >
        <ToggleField
          name="consent.enabled"
          label="Activer la bannière de consentement"
          description="Recommandé. Affiche la bannière en bas de page lors de la première visite."
          defaultChecked={values.enabled}
        />
        <TextField
          name="consent.title"
          label="Titre"
          defaultValue={values.title}
          placeholder="Nous respectons votre vie privée"
        />
        <Textarea
          name="consent.description"
          label="Texte explicatif"
          defaultValue={values.description}
          placeholder="Nous utilisons des cookies pour…"
          rows={4}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="consent.policy_url"
            label="Lien — politique des cookies"
            defaultValue={values.policyUrl}
            placeholder="/cookies"
          />
          <TextField
            name="consent.privacy_url"
            label="Lien — confidentialité"
            defaultValue={values.privacyUrl}
            placeholder="/confidentialite"
          />
        </div>
      </FieldSection>

      <FieldSection
        title="Catégories proposées"
        description="Les cookies strictement nécessaires (session, panier, sécurité) sont toujours actifs et ne s'affichent pas comme option. Activez ici les catégories optionnelles présentées au visiteur."
      >
        <ToggleField
          name="consent.functional_enabled"
          label="Fonctionnels"
          description="Préférences d'affichage, liste d'envies."
          defaultChecked={values.functionalEnabled}
        />
        <ToggleField
          name="consent.analytics_enabled"
          label="Mesure d'audience"
          description="Statistiques de visite (tunnel d'achat, GA4/GTM)."
          defaultChecked={values.analyticsEnabled}
        />
        <ToggleField
          name="consent.marketing_enabled"
          label="Marketing"
          description="Pixels publicitaires (Meta Pixel, remarketing)."
          defaultChecked={values.marketingEnabled}
        />
      </FieldSection>

      <FieldSection
        title="Révision du consentement"
        description="Augmentez ce numéro pour redemander leur consentement à TOUS les visiteurs (par ex. après avoir ajouté une nouvelle balise). Les choix antérieurs deviennent caducs."
      >
        <NumberField
          name="consent.revision"
          label="Révision"
          defaultValue={values.revision}
          min={1}
          helper="Nombre entier. Par défaut : 1."
        />
      </FieldSection>

      {state && !state.ok && <p className="text-sm font-semibold text-[#d40530]">{state.message}</p>}
      {state?.ok && <p className="text-sm font-semibold text-[#15803d]">{state.message}</p>}

      <div className="sticky bottom-4 z-10 flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground shadow-lift transition hover:bg-[#b8042a] disabled:opacity-60"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Enregistrer les réglages cookies
        </button>
      </div>
    </form>
  );
}
