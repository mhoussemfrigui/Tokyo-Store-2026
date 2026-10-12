"use client";

import Link from "next/link";
import { useActionState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Save } from "lucide-react";

import {
  FieldSection,
  NumberField,
  SelectField,
  TextField,
  TextareaField,
  ToggleField,
} from "@/components/admin/_components/setting-fields";
import { FormTabs, FormTab } from "@/components/admin/_components/form-tabs";
import { saveAnalyticsSettingsAction } from "@/lib/actions/analytics";
import { EVENT_GROUPS, type TrackingEventGroup } from "@/lib/tracking/event-groups";
import {
  type ConsentModeStrategy,
  type ConsentSignal,
  type ConsentSignalDefaults,
} from "@/lib/tracking/consent-mode";
import { type ActionState } from "@/lib/actions/types";

type Values = {
  enabled: boolean;
  bypassConsent: boolean;
  mode: ConsentModeStrategy;
  gtmId: string;
  ga4Id: string;
  metaPixelId: string;
  customHead: string;
  customBody: string;
  regionEeaOnly: boolean;
  waitForUpdate: number;
  adsDataRedaction: boolean;
  urlPassthrough: boolean;
  signalDefaults: ConsentSignalDefaults;
  events: Record<TrackingEventGroup, boolean>;
  /** Cross-tab: is the Cookies & RGPD banner enabled? Drives the harmonization note. */
  consentBannerEnabled: boolean;
};

type TabId = "general" | "consent" | "ids" | "events" | "custom";

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "general", label: "Activation" },
  { id: "consent", label: "Consentement" },
  { id: "ids", label: "Identifiants" },
  { id: "events", label: "Événements" },
  { id: "custom", label: "Code personnalisé" },
];

/** The six EDITABLE Consent Mode signals (security_storage is consent-exempt). */
const SIGNAL_FIELDS: ReadonlyArray<{ key: Exclude<ConsentSignal, "security_storage">; label: string }> = [
  { key: "analytics_storage", label: "Mesure d'audience (analytics_storage)" },
  { key: "ad_storage", label: "Cookies publicitaires (ad_storage)" },
  { key: "ad_user_data", label: "Données utilisateur pub (ad_user_data)" },
  { key: "ad_personalization", label: "Personnalisation pub (ad_personalization)" },
  { key: "functionality_storage", label: "Fonctionnel (functionality_storage)" },
  { key: "personalization_storage", label: "Préférences (personalization_storage)" },
];

/** Shown on the owner-only fields (GTM container + custom code) for a non-`*` actor. */
const OWNER_ONLY_NOTE =
  "Réservé au super-administrateur : un conteneur GTM ou un code personnalisé peut exécuter n'importe quel script sur la boutique, avec la session des membres de l'équipe qui la consultent.";

export function AnalyticsSettingsPanel({
  values,
  canEditScripts,
}: {
  values: Values;
  /** Holds the `*` wildcard — may edit the script-capable fields (GTM id + custom code). */
  canEditScripts: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveAnalyticsSettingsAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-border bg-card px-5 py-4">
        <div className="min-w-0 flex-1">
          <p className="max-w-3xl text-[14px] leading-relaxed text-muted-foreground">
            Branchez vos outils de mesure (Google Tag Manager, GA4, Meta Pixel), choisissez les
            événements e-commerce envoyés et pilotez le consentement (Consent Mode v2). Les{" "}
            <span className="font-medium text-foreground">catégories</span> proposées au visiteur se
            règlent dans{" "}
            <Link href="/admin/system/cookies" className="font-medium text-primary hover:underline">
              Système → Cookies &amp; RGPD
            </Link>{" "}
            — les deux onglets sont liés.
          </p>
        </div>
      </header>

      <FormTabs<TabId> tabs={TABS} defaultTab="general">
        {(active) => (
          <>
            {/* ── Activation ─────────────────────────────────────────── */}
            <FormTab id="general" active={active}>
              <FieldSection
                title="Activation"
                description="Le commutateur maître. Tant qu'il est désactivé, AUCUNE balise tierce ne se charge et aucun événement n'est envoyé."
              >
                <ToggleField
                  name="tracking.enabled"
                  label="Activer le suivi & analytics"
                  description="Charge les balises configurées ci-dessous et active la collecte des événements e-commerce."
                  defaultChecked={values.enabled}
                />
              </FieldSection>
            </FormTab>

            {/* ── Consentement ───────────────────────────────────────── */}
            <FormTab id="consent" active={active}>
              {/* Cross-tab harmonization note (issue #2/#3). Bypass takes
                  precedence: it overrides the banner regardless of its state. */}
              {values.bypassConsent ? (
                <div className="flex items-start gap-3 rounded-[16px] border border-[#f3e3bd] bg-[#fff4e0] px-4 py-3.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]" strokeWidth={2} />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Le <span className="font-medium text-foreground">bypass</span> est actif :
                    Consent Mode est forcé en <span className="font-medium text-foreground">« accordé »</span> pour
                    tous et la bannière (si affichée) n&apos;a aucun effet. Vous assumez la conformité.
                  </p>
                </div>
              ) : values.consentBannerEnabled ? (
                <div className="flex items-start gap-3 rounded-[16px] border border-[#cdebd6] bg-[#eaf7ee] px-4 py-3.5">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#15803d]" strokeWidth={2} />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    La bannière de consentement est <span className="font-medium text-foreground">active</span>{" "}
                    (<Link href="/admin/system/cookies" className="text-primary hover:underline">Cookies &amp; RGPD</Link>).
                    Consent Mode respecte le choix du visiteur, masqué par les catégories que vous y proposez.
                  </p>
                </div>
              ) : (
                <div className="flex items-start gap-3 rounded-[16px] border border-[#f3e3bd] bg-[#fff4e0] px-4 py-3.5">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]" strokeWidth={2} />
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    La bannière de consentement est <span className="font-medium text-foreground">désactivée</span>{" "}
                    (<Link href="/admin/system/cookies" className="text-primary hover:underline">Cookies &amp; RGPD</Link>) :
                    Consent Mode démarre donc en <span className="font-medium text-foreground">« accordé »</span> pour
                    tous (aucun blocage). Vous assumez la conformité.
                  </p>
                </div>
              )}

              <FieldSection
                title="Bypass — tout suivre"
                description="Ignore la bannière ET le choix du visiteur : toutes les balises se chargent et collectent pour TOUT LE MONDE. La bannière peut rester affichée mais n'a plus d'effet."
              >
                <ToggleField
                  name="tracking.bypass_consent"
                  label="Activer le bypass du consentement"
                  description="⚠️ Non conforme au RGPD/ePrivacy en UE/UK/TN. À n'utiliser que si vous n'êtes pas soumis à ces obligations (et vous en assumez la responsabilité légale)."
                  defaultChecked={values.bypassConsent}
                />
              </FieldSection>

              <FieldSection
                title="Mode de consentement (Consent Mode v2)"
                description="Comment les balises Google se comportent vis-à-vis du consentement. (Ignoré si le bypass est actif ou la bannière désactivée — tout est alors « accordé ».)"
              >
                <SelectField
                  name="tracking.consent_mode"
                  label="Stratégie"
                  defaultValue={values.mode}
                  options={[
                    { value: "advanced", label: "Avancé — recommandé (modélisation sans cookie)" },
                    { value: "basic", label: "Basique — blocage total avant consentement" },
                    { value: "off", label: "Désactivé — pas de Consent Mode (collecte normale)" },
                  ]}
                  helper="Avancé : les balises se chargent en état « refusé » et n'envoient que des signaux anonymes jusqu'au consentement (recommandé 2026). Basique : aucune balise Google ne se charge avant le consentement. Désactivé : aucun signal Consent Mode — les balises Google collectent normalement (marchés sans obligation, ou gestion 100 % dans GTM)."
                />
                <ToggleField
                  name="tracking.region_eea_only"
                  label="N'exiger le consentement qu'en UE/Royaume-Uni/Tunisie"
                  description="Activé : le refus par défaut ne s'applique qu'à ces régions (collecte complète ailleurs). Désactivé : refus par défaut partout."
                  defaultChecked={values.regionEeaOnly}
                />
                <NumberField
                  name="tracking.cm_wait_for_update"
                  label="Délai d'attente du consentement (wait_for_update, ms)"
                  defaultValue={String(values.waitForUpdate)}
                  min={0}
                  max={5000}
                  step={100}
                  helper="Temps que Google attend une mise à jour de consentement avant d'envoyer les signaux. Par défaut : 500 ms."
                />
                <ToggleField
                  name="tracking.cm_ads_data_redaction"
                  label="Rédaction des données publicitaires (ads_data_redaction)"
                  description="Tant que le consentement pub est refusé, les identifiants publicitaires sont expurgés des requêtes. Recommandé : activé."
                  defaultChecked={values.adsDataRedaction}
                />
                <ToggleField
                  name="tracking.cm_url_passthrough"
                  label="Transmission des identifiants par URL (url_passthrough)"
                  description="Préserve l'attribution (gclid, …) via l'URL quand les cookies sont refusés. Recommandé : activé."
                  defaultChecked={values.urlPassthrough}
                />
              </FieldSection>

              <FieldSection
                title="États par défaut des signaux (avant consentement)"
                description="L'état de chaque signal Google AVANT le choix du visuteur (le « default » de Consent Mode). Par défaut tout est refusé (RGPD). Cochez pour accorder par défaut (opt-out — pour les marchés sans obligation). security_storage est toujours accordé (exempt)."
              >
                {SIGNAL_FIELDS.map((sig) => (
                  <ToggleField
                    key={sig.key}
                    name={`tracking.cm_default_${sig.key}`}
                    label={sig.label}
                    description="Coché = accordé par défaut ; décoché = refusé par défaut (jusqu'au consentement)."
                    defaultChecked={values.signalDefaults[sig.key] === "granted"}
                  />
                ))}
                <ToggleField
                  name="tracking.cm_default_security_storage_locked"
                  label="Sécurité (security_storage)"
                  description="Toujours accordé — couvre l'authentification / l'anti-fraude (exempt de consentement)."
                  defaultChecked
                  disabled
                />
              </FieldSection>
            </FormTab>

            {/* ── Identifiants ───────────────────────────────────────── */}
            <FormTab id="ids" active={active}>
              <FieldSection
                title="Identifiants des balises"
                description="Renseignez les identifiants de vos outils. Si un conteneur GTM est défini, configurez-y GA4 et Meta (le GA4 direct est alors ignoré pour éviter le double comptage). En mode « avancé », les balises NON-Google ajoutées dans GTM (Meta, TikTok…) doivent vérifier la variable dataLayer « gz_consent » avant de se déclencher (Consent Mode ne régit que les balises Google)."
              >
                <TextField
                  name="tracking.gtm_id"
                  label="Google Tag Manager — ID conteneur"
                  defaultValue={values.gtmId}
                  placeholder="GTM-XXXXXXX"
                  disabled={!canEditScripts}
                  helper={
                    canEditScripts
                      ? "Recommandé : un seul conteneur GTM pilote GA4 + Meta + autres balises. Réservé au super-administrateur (un conteneur peut exécuter du code sur la boutique)."
                      : OWNER_ONLY_NOTE
                  }
                />
                <TextField
                  name="tracking.ga4_id"
                  label="Google Analytics 4 — ID de mesure"
                  defaultValue={values.ga4Id}
                  placeholder="G-XXXXXXXXXX"
                  helper="Utilisé uniquement si aucun conteneur GTM n'est défini. Les événements e-commerce (vues produit, ajouts panier, achats…) sont alors envoyés directement à GA4 — aucune configuration GTM requise."
                />
                <TextField
                  name="tracking.meta_pixel_id"
                  label="Meta Pixel — ID"
                  defaultValue={values.metaPixelId}
                  placeholder="123456789012345"
                />
              </FieldSection>
            </FormTab>

            {/* ── Événements e-commerce ──────────────────────────────── */}
            <FormTab id="events" active={active}>
              <FieldSection
                title="Événements e-commerce suivis"
                description="Activez les étapes du tunnel à pousser dans le dataLayer (format GA4 recommandé). Chaque groupe est indépendant."
              >
                {EVENT_GROUPS.map((g) => (
                  <ToggleField
                    key={g.key}
                    name={`tracking.evt.${g.key}`}
                    label={g.label}
                    description={g.description}
                    defaultChecked={values.events[g.key]}
                  />
                ))}
              </FieldSection>
            </FormTab>

            {/* ── Code personnalisé ──────────────────────────────────── */}
            <FormTab id="custom" active={active}>
              <FieldSection
                title="Code personnalisé"
                description="Pour les balises non couvertes par les champs ci-dessus (TikTok, Hotjar…). Le code n'est injecté qu'APRÈS consentement (analytics ou marketing) — même en mode avancé — sauf si le bypass du consentement est actif : il s'exécute alors pour tous les visiteurs. Il n'est PAS retiré automatiquement si le visiteur retire ensuite son consentement. N'y placez jamais de secret — réservé aux balises publiques. Les domaines courants (TikTok, Hotjar, Clarity, LinkedIn) sont autorisés par la CSP ; tout autre domaine doit être ajouté à la variable d'environnement CSP_EXTRA_HOSTS, sinon la balise est bloquée silencieusement."
              >
                {!canEditScripts && (
                  <div className="flex items-start gap-3 rounded-[16px] border border-[#f3e3bd] bg-[#fff4e0] px-4 py-3.5">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#b45309]" strokeWidth={2} />
                    <p className="text-[11px] leading-relaxed text-muted-foreground">{OWNER_ONLY_NOTE}</p>
                  </div>
                )}
                <TextareaField
                  name="tracking.custom_head"
                  label="Code (zone « head »)"
                  defaultValue={values.customHead}
                  rows={5}
                  placeholder="<script>…</script>"
                  disabled={!canEditScripts}
                  helper="HTML/JS injecté tel quel. Les balises <script> sont exécutées."
                />
                <TextareaField
                  name="tracking.custom_body"
                  label="Code (zone « body »)"
                  defaultValue={values.customBody}
                  rows={5}
                  placeholder="<noscript>…</noscript>"
                  disabled={!canEditScripts}
                />
              </FieldSection>
            </FormTab>
          </>
        )}
      </FormTabs>

      {state && !state.ok && <p className="text-sm font-semibold text-[#d40530]">{state.message}</p>}
      {state?.ok && <p className="text-sm font-semibold text-[#15803d]">{state.message}</p>}

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
    </form>
  );
}
