"use client";

import { useActionState } from "react";
import { Loader2, Lock, Save } from "lucide-react";
import { AdminCallout } from "@/components/admin/_components/filter-bar";

import {
  FieldSection,
  SelectField,
  TextField,
  TextareaField,
  ToggleField,
} from "@/components/admin/_components/setting-fields";
import {
  saveRedirectEngineSettingsAction,
  saveNotFoundSettingsAction,
} from "@/lib/actions/redirects";
import { saveSiteModeSettingsAction } from "@/lib/actions/site-mode";
import { type SiteMode } from "@/lib/site-mode/parse";
import { type ActionState } from "@/lib/actions/types";

function SaveBar({ pending, label }: { pending: boolean; label: string }) {
  return (
    <div className="flex justify-end">
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground shadow-lift transition hover:bg-[#b8042a] disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {label}
      </button>
    </div>
  );
}

function Status({ state }: { state: ActionState | null }) {
  if (!state) return null;
  return state.ok ? (
    <p className="text-sm font-semibold text-[#15803d]">{state.message}</p>
  ) : (
    <p className="text-sm text-destructive">{state.message}</p>
  );
}

/** Read-only banner for a viewer without system_redirects:manage — the fieldset
 *  is also disabled and the save button hidden, this just explains why. */
function ReadOnlyNotice() {
  return (
    <AdminCallout tone="warning" icon={Lock}>
      Lecture seule — la permission « gérer » (Redirections &amp; 404) est requise pour
      modifier ces réglages.
    </AdminCallout>
  );
}

export function RedirectEngineSettingsForm({
  enabled,
  canManage,
}: {
  enabled: boolean;
  /** system_redirects:manage — without it the form is read-only. */
  canManage: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    saveRedirectEngineSettingsAction,
    null,
  );
  return (
    <form action={action} className="space-y-5">
      {!canManage && <ReadOnlyNotice />}
      {/* A disabled fieldset natively disables every nested control. */}
      <fieldset disabled={!canManage} className="m-0 min-w-0 space-y-5 border-0 p-0">
        <FieldSection
          title="Moteur de redirection"
          description="Quand c'est activé, les URL de la boutique (produits, catégories, marques et sous-catégories) sont vérifiées contre la table des redirections avant l'affichage : une règle active renvoie le visiteur vers la nouvelle adresse."
        >
          <ToggleField
            name="redirects.enabled"
            label="Activer les redirections"
            description="Désactivez temporairement pour suspendre toutes les redirections sans les supprimer."
            defaultChecked={enabled}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Les redirections s&apos;appliquent aux URL de contenu de la boutique : pages « à plat »
            (<code>/ancienne-page</code>, <code>/ancienne-cat/ancienne-sous-cat</code> — produits,
            catégories, marques) ainsi que <code>/blog/…</code> et
            <code> /promo/…</code> — typiquement d&apos;anciennes adresses retirées ou migrées.
            Elles ne s&apos;appliquent PAS aux pages applicatives (connexion, panier, compte…). Le
            serveur renvoie un <strong>308</strong> (permanent, équivalent 301) ou <strong>307</strong>
            (temporaire, équivalent 302).
          </p>
        </FieldSection>
      </fieldset>
      <Status state={state} />
      {canManage && <SaveBar pending={pending} label="Enregistrer" />}
    </form>
  );
}

export function MaintenanceSettingsForm({
  mode,
  title,
  message,
  launchAt,
  showCountdown,
  canManage,
}: {
  /** system_redirects:manage (the site-mode action's gate) — else read-only. */
  canManage: boolean;
  mode: SiteMode;
  title: string;
  message: string;
  /** Value for the datetime-local input ("YYYY-MM-DDTHH:mm"), or "". */
  launchAt: string;
  showCountdown: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    saveSiteModeSettingsAction,
    null,
  );
  return (
    <form action={action} className="space-y-5">
      {!canManage && <ReadOnlyNotice />}
      <fieldset disabled={!canManage} className="m-0 min-w-0 space-y-5 border-0 p-0">
        <FieldSection
          title="Disponibilité du site"
          description="Fermez temporairement la boutique au public (maintenance) ou affichez une page « bientôt disponible » avant le lancement. Les deux reprennent le style crimson de la page 404 ; la mascotte animée n'apparaît qu'en mode maintenance (« bientôt disponible » affiche plutôt le compte à rebours + vos réseaux sociaux). VOUS, connecté en tant qu'équipe, continuez de voir la boutique normalement. Boutiques, téléphone et réseaux proviennent d'« Identité & contact »."
        >
          <SelectField
            name="site.mode"
            label="Mode du site"
            defaultValue={mode}
            options={[
              { value: "live", label: "En ligne — boutique visible par tous" },
              { value: "maintenance", label: "Maintenance — « nous revenons bientôt »" },
              { value: "coming_soon", label: "Bientôt disponible — avant-lancement" },
            ]}
            helper="« En ligne » = fonctionnement normal. Les deux autres masquent la boutique au public ; l'équipe connectée garde l'accès (connexion via /admin-login)."
          />
          <TextField
            name="site.maintenance_title"
            label="Titre"
            defaultValue={title}
            placeholder="Site en maintenance"
            helper="Laissez vide pour le texte par défaut (adapté au mode choisi)."
          />
          <TextareaField
            name="site.maintenance_message"
            label="Message"
            defaultValue={message}
            rows={3}
            placeholder="Nous peaufinons quelques détails…"
          />
          <TextField
            name="site.launch_at"
            label="Date & heure cible (facultatif)"
            type="datetime-local"
            defaultValue={launchAt}
            helper="Ex. l'ouverture (mode « bientôt ») ou la réouverture après maintenance. Alimente le compte à rebours ci-dessous."
          />
          <ToggleField
            name="site.show_countdown"
            label="Afficher le compte à rebours"
            description="Active/désactive le décompte jusqu'à la date ci-dessus (dans les deux modes). Sans date renseignée, rien ne s'affiche."
            defaultChecked={showCountdown}
          />
        </FieldSection>
      </fieldset>
      <Status state={state} />
      {canManage && <SaveBar pending={pending} label="Enregistrer la disponibilité" />}
    </form>
  );
}

export function NotFoundSettingsForm({
  title,
  message,
  showSearch,
  showSuggestions,
  canManage,
}: {
  /** system_redirects:manage — without it the form is read-only. */
  canManage: boolean;
  title: string;
  message: string;
  showSearch: boolean;
  showSuggestions: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    saveNotFoundSettingsAction,
    null,
  );
  return (
    <form action={action} className="space-y-5">
      {!canManage && <ReadOnlyNotice />}
      <fieldset disabled={!canManage} className="m-0 min-w-0 space-y-5 border-0 p-0">
        <FieldSection
          title="Page 404"
          description="Personnalisez le texte de la page « introuvable » et ce qu'elle propose. Laissez vide pour réutiliser les textes par défaut."
        >
          <TextField
            name="notfound.title"
            label="Titre"
            defaultValue={title}
            placeholder="Page introuvable"
          />
          <TextareaField
            name="notfound.message"
            label="Message"
            defaultValue={message}
            rows={3}
            placeholder="Cette page est introuvable…"
          />
          <ToggleField
            name="notfound.show_search"
            label="Afficher la barre de recherche"
            description="Aide le visiteur à retrouver ce qu'il cherchait."
            defaultChecked={showSearch}
          />
          <ToggleField
            name="notfound.show_suggestions"
            label="Afficher les liens rapides"
            description="Recherche, Reels, Nos boutiques, Journal."
            defaultChecked={showSuggestions}
          />
        </FieldSection>
      </fieldset>
      <Status state={state} />
      {canManage && <SaveBar pending={pending} label="Enregistrer la page 404" />}
    </form>
  );
}
