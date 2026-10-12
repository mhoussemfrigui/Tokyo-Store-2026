"use client";

import { useActionState } from "react";
import { Loader2, Lock, Save } from "lucide-react";
import { AdminCallout } from "@/components/admin/_components/filter-bar";

import {
  FieldSection,
  NumberField,
  SelectField,
  ToggleField,
} from "@/components/admin/_components/setting-fields";
import { saveAuditSettingsAction } from "@/lib/actions/audit-settings";
import { type AuditConfig } from "@/lib/audit/parse-config";
import { type ActionState } from "@/lib/actions/types";

const LEVEL_OPTIONS = [
  { value: "off", label: "Off — aucune sortie console" },
  { value: "error", label: "Erreur uniquement" },
  { value: "warn", label: "Alerte et plus" },
  { value: "info", label: "Info et plus (défaut)" },
  { value: "debug", label: "Debug — tout" },
];

/**
 * "Réglages" panel of the audit control center — capture + debug + retention
 * settings. Self-contained `<form>` posting to saveAuditSettingsAction, which
 * re-clamps through resolveAuditConfig (the same resolver the subscribers read).
 * Read-only for operators without system_audit:manage (disabled fieldset).
 */
export function AuditSettingsForm({
  values,
  canManage,
}: {
  values: AuditConfig;
  canManage: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveAuditSettingsAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-8">
      {!canManage && (
        <AdminCallout tone="warning" icon={Lock}>
          Lecture seule — la permission « gérer » est requise pour modifier ces réglages.
        </AdminCallout>
      )}
      <fieldset disabled={!canManage} className="m-0 min-w-0 space-y-8 border-0 p-0">
        <FieldSection
          title="Capture"
          description="Ce qui est enregistré dans le journal d'audit et écrit dans les logs du serveur. Chaque événement porte une sévérité (debug · info · alerte · erreur)."
        >
          <ToggleField
            name="audit.enabled"
            label="Capture activée"
            description="Interrupteur principal. Désactivé : plus aucun événement n'est enregistré ni journalisé (à n'utiliser qu'en dépannage). La désactivation elle-même reste tracée."
            defaultChecked={values.enabled}
          />
          <SelectField
            name="audit.log_level"
            label="Niveau de journalisation (console)"
            defaultValue={values.logLevel}
            options={LEVEL_OPTIONS}
            helper="Seuil des lignes JSON écrites dans les logs serveur. N'affecte PAS les lignes enregistrées en base. Par défaut : Info."
          />
          <ToggleField
            name="audit.persist_low_signal"
            label="Conserver les événements à faible signal"
            description="Activé (défaut) : tout est enregistré en base. Désactivé : les événements de sévérité « debug » (churn de cache) ne sont pas enregistrés — la table reste légère ; info/alerte/erreur le sont toujours."
            defaultChecked={values.persistLowSignal}
          />
        </FieldSection>

        <FieldSection
          title="Débogage"
          description="Capture détaillée temporaire pour le dépannage. À laisser désactivé en production — peut générer un volume de logs important."
        >
          <ToggleField
            name="debug.enabled"
            label="Mode débogage"
            description="Force le niveau console à « debug » (tout est journalisé) quel que soit le niveau ci-dessus. Pensez à le redésactiver après dépannage."
            defaultChecked={values.debugEnabled}
          />
          <ToggleField
            name="debug.capture_payloads"
            label="Inclure les payloads dans les logs"
            description="En mode débogage, ajoute le contenu (rédigé/masqué) de chaque événement à la ligne de log. Sans cela, les lignes restent légères."
            defaultChecked={values.debugCapturePayloads}
          />
          <NumberField
            name="debug.sample_rate"
            label="Taux d'échantillonnage debug (%)"
            defaultValue={String(values.debugSampleRate)}
            min={0}
            max={100}
            step={5}
            helper="Pourcentage des lignes de sévérité « debug » réellement écrites en mode débogage (0 à 100). Les alertes/erreurs ne sont jamais échantillonnées. Par défaut : 100."
          />
        </FieldSection>

        <FieldSection
          title="Rétention"
          description="La purge automatique quotidienne (Tâches planifiées) supprime les entrées du journal plus anciennes que cette fenêtre."
        >
          <NumberField
            name="audit.retention_months"
            label="Conservation du journal d'audit (mois)"
            defaultValue={String(values.retentionMonths)}
            min={1}
            max={60}
            step={1}
            helper="Durée de conservation des entrées d'audit (1 à 60 mois). Par défaut : 12 mois."
          />
        </FieldSection>
      </fieldset>

      {state && !state.ok && <p className="text-sm text-destructive">{state.message}</p>}
      {state?.ok && <p className="text-sm font-semibold text-[#15803d]">{state.message}</p>}

      {canManage && (
        <div className="sticky bottom-4 z-10 flex justify-end">
          <button
            type="submit"
            disabled={pending}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground shadow-lift transition hover:bg-[#b8042a] disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Enregistrer les réglages
          </button>
        </div>
      )}
    </form>
  );
}
