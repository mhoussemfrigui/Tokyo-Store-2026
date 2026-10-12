"use client";

import { useActionState } from "react";
import { Loader2, Lock, Save } from "lucide-react";
import { AdminCallout } from "@/components/admin/_components/filter-bar";

import {
  FieldSection,
  NumberField,
  TextField,
  ToggleField,
} from "@/components/admin/_components/setting-fields";
import { savePerfSettingsAction } from "@/lib/actions/perf-settings";
import { type PerfConfig } from "@/lib/telemetry/perf-config";
import { type ActionState } from "@/lib/actions/types";

/**
 * "Réglages" panel of the Performance control center — sampling cadence + warn
 * thresholds + alert/notification settings. Self-contained `<form>` posting to
 * savePerfSettingsAction, which re-clamps through resolvePerformanceConfig (the
 * same resolver the sampler reads). Read-only for operators without
 * system_performance:manage (disabled fieldset).
 */
export function PerfSettingsForm({
  values,
  canManage,
}: {
  values: PerfConfig;
  canManage: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    savePerfSettingsAction,
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
          title="Échantillonnage"
          description="Le collecteur interne (sans cron externe) mesure RAM, CPU, boucle d'évènements et latence DB à intervalle régulier. Mesures propres à chaque instance Node."
        >
          <ToggleField
            name="perf.sampling_enabled"
            label="Échantillonnage activé"
            description="Désactivé : l'échantillonnage CPU / boucle d'évènements et l'évaluation des seuils se mettent en pause. Le heartbeat et le suivi disponibilité/indisponibilité, ainsi que la RAM et la latence DB en direct, continuent. À laisser activé."
            defaultChecked={values.samplingEnabled}
          />
          <NumberField
            name="perf.sample_interval_sec"
            label="Intervalle d'échantillonnage (s)"
            defaultValue={String(values.sampleIntervalSec)}
            min={5}
            max={300}
            step={5}
            helper="Fréquence des mesures live + évaluation des seuils (5 à 300 s). Par défaut : 10 s."
          />
          <NumberField
            name="perf.history_size"
            label="Taille de l'historique (échantillons)"
            defaultValue={String(values.historySize)}
            min={60}
            max={1440}
            step={10}
            helper="Nombre de mesures conservées en mémoire pour le graphe Historique (60 à 1440). Par défaut : 360 (≈ 1 h à 10 s)."
          />
          <NumberField
            name="perf.heartbeat_interval_sec"
            label="Intervalle de heartbeat (s)"
            defaultValue={String(values.heartbeatIntervalSec)}
            min={30}
            max={3600}
            step={30}
            helper="Fréquence d'écriture du battement en base (suivi disponibilité/indisponibilité entre redémarrages). Par défaut : 60 s."
          />
        </FieldSection>

        <FieldSection
          title="Seuils d'alerte"
          description="Une métrique au-dessus de son seuil pendant le nombre d'échantillons requis déclenche une alerte (toujours tracée au journal d'audit ; email optionnel ci-dessous)."
        >
          <NumberField
            name="perf.ram_warn_pct"
            label="Seuil RAM (% de la limite)"
            defaultValue={String(values.ramWarnPct)}
            min={50}
            max={99}
            step={1}
            helper="Pourcentage du RSS par rapport à la limite mémoire du conteneur (50 à 99). Par défaut : 85."
          />
          <NumberField
            name="perf.cpu_warn_pct"
            label="Seuil CPU (%)"
            defaultValue={String(values.cpuWarnPct)}
            min={50}
            max={100}
            step={1}
            helper="Utilisation CPU du process normalisée par cœur (50 à 100). Par défaut : 90."
          />
          <NumberField
            name="perf.event_loop_lag_warn_ms"
            label="Seuil boucle d'évènements p99 (ms)"
            defaultValue={String(values.eventLoopLagWarnMs)}
            min={20}
            max={2000}
            step={10}
            helper="Latence p99 de la boucle d'évènements Node (20 à 2000 ms). Par défaut : 200."
          />
          <NumberField
            name="perf.db_latency_warn_ms"
            label="Seuil latence DB (ms)"
            defaultValue={String(values.dbLatencyWarnMs)}
            min={50}
            max={5000}
            step={50}
            helper="Aller-retour d'un SELECT 1 (50 à 5000 ms). Par défaut : 500. Une base injoignable déclenche toujours une alerte."
          />
          <NumberField
            name="perf.alert_breaches_required"
            label="Échantillons consécutifs requis"
            defaultValue={String(values.alertBreachesRequired)}
            min={1}
            max={10}
            step={1}
            helper="Nombre de mesures successives au-dessus du seuil avant de déclencher (anti-rebond). Par défaut : 2."
          />
        </FieldSection>

        <FieldSection
          title="Notifications"
          description="En plus de la trace au journal d'audit, un email peut être envoyé aux responsables lors d'un dépassement (et au rétablissement)."
        >
          <ToggleField
            name="perf.alert_email_enabled"
            label="Envoyer les alertes par email"
            description="Désactivé par défaut. Activé : un email transactionnel part lors d'un dépassement soutenu et lors du rétablissement."
            defaultChecked={values.alertEmailEnabled}
          />
          <NumberField
            name="perf.alert_cooldown_min"
            label="Délai anti-répétition (min)"
            defaultValue={String(values.alertCooldownMin)}
            min={5}
            max={1440}
            step={5}
            helper="Durée pendant laquelle une même métrique ne re-déclenche pas (5 à 1440 min). Par défaut : 30."
          />
          <TextField
            name="perf.alert_recipients"
            label="Destinataires des alertes"
            defaultValue={values.alertRecipients.join(", ")}
            placeholder="ops@exemple.tn, admin@exemple.tn"
            helper="Adresses séparées par des virgules. Laisser vide : les comptes administrateurs actifs reçoivent les alertes. Max 20."
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
