"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, Lock, RotateCcw, Save } from "lucide-react";
import { AdminCallout } from "@/components/admin/_components/filter-bar";

import {
  saveAiProviderSettingsAction,
  saveAiEmbeddingSettingsAction,
  saveAiFeaturePromptsAction,
} from "@/lib/actions/ai-settings";
import { type ActionState } from "@/lib/actions/types";
import {
  AI_MODEL_SUGGESTIONS,
  AI_MODEL_OPTIONS,
  modelDatalistId,
  ALL_MODELS_DATALIST_ID,
} from "@/lib/ai/models";
import {
  EMBEDDING_MODEL_SUGGESTIONS,
  recommendedEmbeddingModel,
} from "@/lib/ai/embedding-models";
import { FormTabs, FormTab } from "@/components/admin/_components/form-tabs";
import {
  FieldSection,
  SecretField,
  SelectField,
  TextField,
  TextareaField,
  ToggleField,
} from "@/components/admin/_components/setting-fields";

export type AiProviderCardData = {
  id: "openrouter" | "deepseek" | "openai" | "anthropic";
  label: string;
  enabled: boolean;
  /** A key resolved (env or DB) — used for the "Configuré" badge + status line. */
  configured: boolean;
  source: "env" | "admin" | "none";
  /** apiKeyEnv is set → the key field is locked + the env value wins. */
  envLocked: boolean;
  /** The env-var name to show in the lock badge ("Défini via <ENV_VAR>"). */
  apiKeyEnv: string;
  /** Current custom base URL (empty if none — placeholder shows the default). */
  baseUrl: string;
  /** Current default model id (non-secret). */
  defaultModel: string;
  /** Placeholder = the provider's defaultBaseUrl. */
  baseUrlPlaceholder: string;
  docsUrl?: string;
  keyHint?: string;
};

/** One generation task (merge of the code catalog + stored override). */
export type FeatureTaskData = {
  id: string;
  label: string;
  description: string;
  kind: "text" | "attribution";
  /** The stored system-prompt OVERRIDE, or "" when the task uses the code default. */
  customPrompt: string;
  /** The code-default prompt (tasks.ts) — placeholder + « Partir du prompt par défaut ». */
  defaultSystemPrompt: string;
  /** Provider override id, or "" for "Par défaut" (auto-pick). */
  provider: string;
  /** Model override, or "". */
  model: string;
  enabled: boolean;
};

/** One AI_FEATURES entry → one prompt tab. */
export type FeaturePromptsData = {
  id: string;
  label: string;
  tasks: FeatureTaskData[];
  /** The stored overrides could not be read — the tab renders read-only so a
   *  save can't overwrite real custom prompts with blanks. */
  loadFailed: boolean;
};

/** A configured+enabled provider, for the per-task provider <select>. */
export type ProviderOption = { value: string; label: string };

const SOURCE_LABEL: Record<AiProviderCardData["source"], string> = {
  env: "Source : variable d'environnement",
  admin: "Source : clé enregistrée (admin)",
  none: "Non configuré",
};

/**
 * AI & Automation hub — Réglages + one prompt tab per AI feature (every
 * AI_FEATURES entry: Produits, Catégories, Marques, Collections, Attributs,
 * Avis) in a shared tab-strip:
 *
 *   • Réglages → the 4 provider cards (API keys, base URL, default model,
 *     enabled). Write-only credentials; env vars force-override + lock a key
 *     (and, for a non-owner, that provider's base URL too).
 *   • One tab per feature → one card per generation task (description, FAQ,
 *     SEO, …): an optional system-prompt override (empty = the code default),
 *     an optional provider/model override, and an on/off toggle. These prompts
 *     power one-click + bulk generation in the matching admin editors.
 *
 * Each tab owns its OWN `<form>` + action, so we drive the active tab with
 * controlled state (the render-prop tabs only switch visibility; sibling forms
 * live outside the strip). Credentials are never sent back to the browser.
 */
/** Datalist id for the embedding-model field (recommended 1536-dim models). */
const EMBEDDING_MODELS_DATALIST_ID = "tk-embedding-models";

export function AiSettingsPanel({
  providers,
  features,
  providerOptions,
  embeddingProvider,
  embeddingModel,
  canUpdate,
  canEditBaseUrl,
}: {
  providers: AiProviderCardData[];
  /** One entry per AI_FEATURES feature, in catalog order. */
  features: FeaturePromptsData[];
  providerOptions: ProviderOption[];
  /** `ai.embedding_provider` — "" = auto-pick (first embedding-capable provider). */
  embeddingProvider: string;
  /** `ai.embedding_model` — "" = the code default (text-embedding-3-small). */
  embeddingModel: string;
  /** system_ai:update — false ⇒ every form renders read-only (no save button). */
  canUpdate: boolean;
  /** Super-admin (`*`) — may move an env-keyed provider's base URL. */
  canEditBaseUrl: boolean;
}) {
  const [activeTab, setActiveTab] = useState<string>("reglages");

  // The two infrastructure tabs (Réglages = provider keys, Embeddings = semantic
  // search provider/model) group ahead of the per-feature prompt tabs.
  const tabs = [
    { id: "reglages", label: "Réglages" },
    { id: "embeddings", label: "Embeddings" },
    ...features.map((f) => ({ id: f.id, label: f.label })),
  ];

  return (
    <FormTabs
      tabs={tabs}
      defaultTab="reglages"
      activeTab={activeTab}
      onActiveTabChange={setActiveTab}
    >
      {(active) => (
        <>
          <FormTab id="reglages" active={active}>
            <ProvidersForm
              providers={providers}
              canUpdate={canUpdate}
              canEditBaseUrl={canEditBaseUrl}
            />
          </FormTab>
          <FormTab id="embeddings" active={active}>
            <EmbeddingsForm
              embeddingProvider={embeddingProvider}
              embeddingModel={embeddingModel}
              canUpdate={canUpdate}
            />
          </FormTab>
          {features.map((f) => (
            <FormTab key={f.id} id={f.id} active={active}>
              <FeaturePromptsForm
                feature={f.id}
                tasks={f.tasks}
                providerOptions={providerOptions}
                canUpdate={canUpdate}
                loadFailed={f.loadFailed}
              />
            </FormTab>
          ))}
        </>
      )}
    </FormTabs>
  );
}

/* ────────────────────────────── Réglages tab ────────────────────────────── */

/** The base-URL field shows only a CUSTOM value (the provider default is the placeholder). */
function baseUrlFieldValue(p: AiProviderCardData): string {
  return p.baseUrl === p.baseUrlPlaceholder ? "" : p.baseUrl;
}

/**
 * The 4 provider cards, one shared `<form>`. The API key is write-only — the
 * stored/decrypted value is NEVER sent to the browser; an empty field keeps the
 * existing key. An env-locked provider disables its key input and shows a
 * "Défini via <ENV_VAR>" lock badge. Base URL + default model are non-secret —
 * but the base URL is WHERE the key is sent, so for a non-owner an env-keyed
 * provider's base URL is shown locked (a hidden input re-submits the current
 * value; the workflow refuses a change anyway), and a stored-key provider's
 * helper says the key must be re-entered to move it.
 */
function ProvidersForm({
  providers,
  canUpdate,
  canEditBaseUrl,
}: {
  providers: AiProviderCardData[];
  canUpdate: boolean;
  canEditBaseUrl: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveAiProviderSettingsAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-6">
      {!canUpdate && <ReadOnlyNotice />}
      <fieldset disabled={!canUpdate} className="m-0 min-w-0 space-y-6 border-0 p-0">
      <div className="rounded-2xl border border-dashed border-border bg-surface/40 px-5 py-4 text-xs leading-relaxed text-muted-foreground">
        <p className="font-semibold text-foreground">Comment ces clés sont utilisées</p>
        <p className="mt-1.5">
          Ces identifiants alimentent la génération de contenu par IA dans les
          éditeurs{" "}
          <span className="font-semibold text-foreground">
            Produits, Catégories, Marques, Collections, Attributs
          </span>{" "}
          ainsi que la{" "}
          <span className="font-semibold text-foreground">génération d&apos;avis</span>{" "}
          et la{" "}
          <span className="font-semibold text-foreground">recherche sémantique</span>,
          via un point d&apos;accès unique mis en cache. Les clés sont chiffrées en
          base ; une variable d&apos;environnement définie (ex.{" "}
          <span className="font-semibold text-foreground">OPENROUTER_API_KEY</span>)
          a la priorité sur la valeur enregistrée et verrouille le champ. Le
          fournisseur et le modèle d&apos;embeddings (recherche sémantique) se
          choisissent dans l&apos;onglet{" "}
          <span className="font-semibold text-foreground">Embeddings</span>.
        </p>
      </div>

      {providers.map((p) => (
        <div key={p.id} className="rounded-[22px] border border-border bg-card p-5 sm:p-6">
          <FieldSection title={p.label} description={p.docsUrl ? undefined : p.keyHint}>
            {p.docsUrl && (
              <a
                href={p.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="-mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
              >
                Documentation / clés API <ExternalLink className="h-3 w-3" />
              </a>
            )}

            <ToggleField
              name={`ai.${p.id}.enabled`}
              label={`Activer ${p.label}`}
              description="Rend ce fournisseur disponible pour les fonctions d'IA & d'automatisation."
              defaultChecked={p.enabled}
            />

            <SecretField
              name={`secret.${p.id}.api_key`}
              label="Clé API"
              hasValue={p.configured}
              locked={p.envLocked}
              helper={
                p.envLocked
                  ? `Défini via ${p.apiKeyEnv}`
                  : `Variable d'environnement (prioritaire) : ${p.apiKeyEnv}. ${p.keyHint ?? ""}`.trim()
              }
            />

            {p.envLocked && !canEditBaseUrl ? (
              <>
                {/* Disabled inputs submit nothing — re-send the current value so a
                    save keeps it (the workflow refuses any change from a non-owner). */}
                <TextField
                  name={`ai.${p.id}.base_url`}
                  label="URL de base (optionnel)"
                  defaultValue={baseUrlFieldValue(p)}
                  placeholder={p.baseUrlPlaceholder}
                  disabled
                  locked
                  helper="Réservé à un super-administrateur : la clé API de ce fournisseur est définie par variable d'environnement, son URL de destination ne peut pas être modifiée par délégation."
                />
                <input type="hidden" name={`ai.${p.id}.base_url`} value={baseUrlFieldValue(p)} />
              </>
            ) : (
              <TextField
                name={`ai.${p.id}.base_url`}
                label="URL de base (optionnel)"
                defaultValue={baseUrlFieldValue(p)}
                placeholder={p.baseUrlPlaceholder}
                helper={
                  !canEditBaseUrl && p.source === "admin"
                    ? "Laissez vide pour utiliser l'endpoint par défaut du fournisseur. Pour la modifier, saisissez à nouveau la clé API dans le même enregistrement (la clé suit l'URL)."
                    : "Laissez vide pour utiliser l'endpoint par défaut du fournisseur."
                }
              />
            )}

            <TextField
              name={`ai.${p.id}.default_model`}
              label="Modèle par défaut (optionnel)"
              defaultValue={p.defaultModel}
              placeholder="ex. gpt-4o-mini, deepseek-chat, claude-…"
              list={modelDatalistId(p.id)}
              helper="Modèle utilisé par défaut par les fonctions d'IA. Choisissez une suggestion ou saisissez n'importe quel identifiant pris en charge par ce fournisseur."
            />
            <datalist id={modelDatalistId(p.id)}>
              {(AI_MODEL_SUGGESTIONS[p.id] ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {SOURCE_LABEL[p.source]}
            </p>
          </FieldSection>
        </div>
      ))}
      </fieldset>

      <ActionFeedback state={state} />
      {canUpdate && <SaveBar pending={pending} label="Enregistrer la configuration" />}
    </form>
  );
}

/* ────────────────────────────── Embeddings tab ──────────────────────────────── */

/**
 * Embeddings (semantic search) — its OWN tab + form, split out of the provider
 * form so a plain provider save can never blank these (and vice-versa). Records
 * WHICH embedding-capable provider + model to use; the API key itself is the
 * per-provider encrypted secret saved in the Réglages tab. Posts to the dedicated
 * saveAiEmbeddingSettingsAction. The page reads ai.embedding_provider /
 * ai.embedding_model strictly (no `.catch`) so a degraded read hits the admin
 * error boundary rather than pre-filling blanks a save would persist.
 */
function EmbeddingsForm({
  embeddingProvider,
  embeddingModel,
  canUpdate,
}: {
  embeddingProvider: string;
  embeddingModel: string;
  canUpdate: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveAiEmbeddingSettingsAction,
    null,
  );

  // Non-reactive placeholder + union datalist (Tokyo's SelectField has no onChange):
  // suggest the recommended model for the currently-saved provider, and offer every
  // 1536-compatible model in the datalist regardless of the picked provider.
  const embPlaceholder = recommendedEmbeddingModel(embeddingProvider || "openrouter");
  const embSuggestions = [
    ...(EMBEDDING_MODEL_SUGGESTIONS.openrouter ?? []),
    ...(EMBEDDING_MODEL_SUGGESTIONS.openai ?? []),
  ];

  return (
    <form action={formAction} className="space-y-6">
      {!canUpdate && <ReadOnlyNotice />}
      <fieldset disabled={!canUpdate} className="m-0 min-w-0 space-y-6 border-0 p-0">
        <div className="rounded-2xl border border-dashed border-border bg-surface/40 px-5 py-4 text-xs leading-relaxed text-muted-foreground">
          <p className="font-semibold text-foreground">Recherche sémantique</p>
          <p className="mt-1.5">
            Choisissez le fournisseur et le modèle qui vectorisent vos produits pour la
            recherche par le sens. Ils réutilisent les clés configurées dans l&apos;onglet{" "}
            <span className="font-semibold text-foreground">Réglages</span> — aucune clé
            dédiée n&apos;est requise. Une fois réglé, lancez la vectorisation du catalogue
            dans{" "}
            <span className="font-semibold text-foreground">
              Système → Recherche → Sémantique
            </span>
            .
          </p>
        </div>

        <div className="rounded-[22px] border border-border bg-card p-5 sm:p-6">
          <FieldSection
            title="Embeddings (recherche sémantique)"
            description="Le fournisseur + modèle qui vectorisent les produits pour la recherche par le sens. Réutilise vos fournisseurs configurés dans l'onglet Réglages — OpenRouter (recommandé, un seul accès pour les modèles OpenAI/Google/…) ou OpenAI en direct. Anthropic ne fournit pas d'embeddings. Le modèle doit produire des vecteurs de 1536 dimensions."
          >
            <SelectField
              name="ai.embedding_provider"
              label="Fournisseur d'embeddings"
              defaultValue={embeddingProvider}
              options={[
                { value: "", label: "Auto (1er fournisseur compatible configuré)" },
                { value: "openrouter", label: "OpenRouter" },
                { value: "openai", label: "OpenAI (direct)" },
              ]}
              helper="« Auto » prend le premier fournisseur compatible configuré et activé dans l'onglet Réglages — donc OpenRouter si c'est celui que vous utilisez. Aucune clé OpenAI dédiée n'est requise."
            />
            <TextField
              name="ai.embedding_model"
              label="Modèle d'embeddings"
              defaultValue={embeddingModel}
              placeholder={embPlaceholder}
              list={EMBEDDING_MODELS_DATALIST_ID}
              helper="Vide = modèle recommandé du fournisseur (OpenRouter → openai/text-embedding-3-small ; OpenAI → text-embedding-3-small). Sur OpenRouter, l'id est préfixé « openai/ ». Choisissez une suggestion ou saisissez le vôtre — il doit sortir en 1536 dimensions, sinon il est refusé (colonne vectorielle fixée à 1536 ; les modèles OpenAI 3-large sont réduits automatiquement)."
            />
            <datalist id={EMBEDDING_MODELS_DATALIST_ID}>
              {embSuggestions.map((m) => (
                <option key={m.model} value={m.model} label={m.label} />
              ))}
            </datalist>
          </FieldSection>
        </div>
      </fieldset>

      <ActionFeedback state={state} />
      {canUpdate && <SaveBar pending={pending} label="Enregistrer les embeddings" />}
    </form>
  );
}

/* ──────────────────────────── Feature prompt tabs ─────────────────────────── */

/**
 * One card per generation task, one form bound to one AI feature. The content
 * tasks (text) and the attribution tasks are visually grouped via FieldSection
 * headers. Each task posts `prompt.<id>`, `provider.<id>`, `model.<id>`,
 * `enabled.<id>` into this form. An empty prompt (or one identical to the code
 * default) is stored as NULL, so the task keeps following the shipped default.
 */
function FeaturePromptsForm({
  feature,
  tasks,
  providerOptions,
  canUpdate,
  loadFailed,
}: {
  feature: string;
  tasks: FeatureTaskData[];
  providerOptions: ProviderOption[];
  canUpdate: boolean;
  loadFailed: boolean;
}) {
  // A failed read shows blank overrides — saving would erase real custom prompts.
  const editable = canUpdate && !loadFailed;
  // Bind the feature id so the action signature stays (prev, formData).
  const saveAction = saveAiFeaturePromptsAction.bind(null, feature);
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveAction,
    null,
  );

  // "Par défaut" first, then the configured+enabled providers.
  const providerSelectOptions: ProviderOption[] = [
    { value: "", label: "Par défaut (premier fournisseur configuré)" },
    ...providerOptions,
  ];

  const generationTasks = tasks.filter((t) => t.kind === "text");
  const attributionTasks = tasks.filter((t) => t.kind === "attribution");

  return (
    <form action={formAction} className="space-y-6">
      {loadFailed ? (
        <p className="rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          Impossible de charger les prompts enregistrés pour cet onglet — rechargez la page
          avant de modifier (enregistrer maintenant effacerait vos prompts personnalisés).
        </p>
      ) : (
        !canUpdate && <ReadOnlyNotice />
      )}
      <fieldset disabled={!editable} className="m-0 min-w-0 space-y-6 border-0 p-0">
      {/* Merged model suggestions (all providers) for the per-task model fields. */}
      <datalist id={ALL_MODELS_DATALIST_ID}>
        {AI_MODEL_OPTIONS.map((o, i) => (
          <option key={`${o.providerLabel}-${o.model}-${i}`} value={o.model} label={o.providerLabel} />
        ))}
      </datalist>

      <div className="rounded-2xl border border-dashed border-border bg-surface/40 px-5 py-4 text-xs leading-relaxed text-muted-foreground">
        <p className="font-semibold text-foreground">Génération en un clic</p>
        <p className="mt-1.5">
          Ces prompts alimentent la génération en un clic (boutons « Générer (IA) »)
          dans l&apos;éditeur correspondant. Laissez un prompt vide pour utiliser le prompt
          par défaut intégré (affiché en grisé, et mis à jour avec l&apos;application), ou
          saisissez le vôtre pour votre ton — « Réinitialiser » revient au prompt par
          défaut. Le fournisseur «{" "}
          <span className="font-semibold text-foreground">Par défaut</span> » utilise
          le premier fournisseur configuré et activé dans l&apos;onglet{" "}
          <span className="font-semibold text-foreground">Réglages</span> ; les clés
          sont gérées là-bas (les variables d&apos;environnement restent prioritaires).
        </p>
      </div>

      {providerOptions.length === 0 && (
        <div className="rounded-[16px] border border-[#f3e3bd] bg-[#fff4e0] p-3 text-xs font-semibold text-[#b45309]">
          Aucun fournisseur IA configuré et activé. Configurez-en un dans l&apos;onglet
          Réglages pour activer la génération.
        </div>
      )}

      {/* Only render when the feature actually has text tasks — the Attributs
          feature is attribution-only, so this header would otherwise sit empty. */}
      {generationTasks.length > 0 && (
        <FieldSection
          title="Génération de contenu"
          description="Descriptions, FAQ et métadonnées SEO générées en texte libre."
        >
          {generationTasks.map((t) => (
            <TaskCard key={t.id} task={t} providerOptions={providerSelectOptions} />
          ))}
        </FieldSection>
      )}

      {attributionTasks.length > 0 && (
        <FieldSection
          title="Attribution automatique"
          description="Catégories, attributs et variantes choisis parmi les options existantes (JSON)."
        >
          {attributionTasks.map((t) => (
            <TaskCard key={t.id} task={t} providerOptions={providerSelectOptions} />
          ))}
        </FieldSection>
      )}
      </fieldset>

      <ActionFeedback state={state} />
      {editable && <SaveBar pending={pending} label="Enregistrer les prompts" />}
    </form>
  );
}

/**
 * One generation-task card: prompt override textarea (empty = code default,
 * shown as the placeholder) + « Partir du prompt par défaut » / « Réinitialiser »
 * + provider/model overrides + toggle. The textarea stays uncontrolled (React 19
 * form reset re-applies the saved override), so the two buttons just set its DOM
 * value; nothing is stored until the form is saved.
 */
function TaskCard({
  task,
  providerOptions,
}: {
  task: FeatureTaskData;
  providerOptions: ProviderOption[];
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  // The chip reflects the LIVE textarea content (the field is uncontrolled), not
  // just the saved prop — so typing, « Réinitialiser » and « Partir du défaut »
  // update it at once. isCustom = the field holds non-empty text (what will be
  // persisted: blank saves as NULL → the built-in default).
  const [isCustom, setIsCustom] = useState(task.customPrompt.trim() !== "");
  const setPrompt = (value: string) => {
    const el = cardRef.current?.querySelector("textarea");
    if (!el) return;
    el.value = value;
    setIsCustom(value.trim() !== "");
    el.focus();
  };
  // Keep the chip live as the operator types. TextareaField doesn't forward an
  // onInput prop, so bind the listener on the rendered textarea via the card ref.
  useEffect(() => {
    const el = cardRef.current?.querySelector("textarea");
    if (!el) return;
    const onInput = () => setIsCustom(el.value.trim() !== "");
    el.addEventListener("input", onInput);
    return () => el.removeEventListener("input", onInput);
  }, []);

  return (
    <div ref={cardRef} className="rounded-[22px] border border-border bg-card p-5">
      <TextareaField
        name={`prompt.${task.id}`}
        label={task.label}
        defaultValue={task.customPrompt}
        rows={5}
        helper={`${task.description} Vide = prompt par défaut intégré (affiché en grisé).`}
        placeholder={task.defaultSystemPrompt}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {isCustom ? "Prompt personnalisé" : "Prompt par défaut intégré"}
        </span>
        <button
          type="button"
          onClick={() => setPrompt(task.defaultSystemPrompt)}
          className="rounded-full px-2 py-0.5 text-[11px] font-medium text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Partir du prompt par défaut
        </button>
        <button
          type="button"
          onClick={() => setPrompt("")}
          title="Vide le champ : après enregistrement, la tâche utilise le prompt par défaut intégré."
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw className="h-3 w-3" /> Réinitialiser
        </button>
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <SelectField
          name={`provider.${task.id}`}
          label="Fournisseur"
          defaultValue={task.provider}
          options={providerOptions}
          helper="« Par défaut » = premier fournisseur configuré et activé."
        />
        <TextField
          name={`model.${task.id}`}
          label="Modèle (optionnel)"
          defaultValue={task.model}
          placeholder="modèle par défaut du fournisseur"
          list={ALL_MODELS_DATALIST_ID}
          helper="Choisissez un modèle (toutes plateformes) ou saisissez le vôtre. Vide = modèle par défaut du fournisseur."
        />
      </div>
      <div className="mt-4">
        <ToggleField
          name={`enabled.${task.id}`}
          label="Activer cette tâche"
          description="Décochez pour masquer le bouton de génération correspondant."
          defaultChecked={task.enabled}
        />
      </div>
    </div>
  );
}

/* ─────────────────────────────── shared bits ────────────────────────────── */

function ActionFeedback({ state }: { state: ActionState | null }) {
  if (!state) return null;
  if (!state.ok) {
    return (
      <div
        role="alert"
        className="rounded-2xl border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive"
      >
        {state.message}
      </div>
    );
  }
  return (
    <div
      role="status"
      className="rounded-[16px] border border-[#cdebd6] bg-[#eaf7ee] p-3 text-xs font-semibold text-[#15803d]"
    >
      {state.message}
    </div>
  );
}

/** Read-only banner for a viewer without system_ai:update — the fieldset is also
 *  disabled and the save button hidden, this just explains why. */
function ReadOnlyNotice() {
  return (
    <AdminCallout tone="warning" icon={Lock}>
      Lecture seule — la permission «&nbsp;modifier&nbsp;» (system_ai) est requise pour enregistrer.
    </AdminCallout>
  );
}

function SaveBar({ pending, label }: { pending: boolean; label: string }) {
  return (
    <div className="sticky bottom-4 z-10 flex items-center justify-end">
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-[14px] font-extrabold text-primary-foreground shadow-lift transition hover:bg-[#b8042a] disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {pending ? "Enregistrement…" : label}
      </button>
    </div>
  );
}
