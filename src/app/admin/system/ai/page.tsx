import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/session";
import { permissionSetAllows, resolveUserPermissions } from "@/lib/rbac/authorize";
import { WILDCARD } from "@/lib/rbac/registry";
import { listAiProviderStatus } from "@/lib/ai/config";
import { AI_PROVIDERS } from "@/lib/ai/providers";
import { AI_FEATURES, type AiFeature } from "@/lib/ai/tasks";
import { aiFeaturePromptsService, type AiFeaturePromptRow } from "@/modules/ai";
import { getSettingsMap } from "@/modules/cms/setting/queries";
import { asStr } from "@/lib/cms/setting-coerce";

import {
  AiSettingsPanel,
  type AiProviderCardData,
  type FeaturePromptsData,
  type FeatureTaskData,
  type ProviderOption,
} from "./ai-settings-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "IA & Automation" };

/**
 * AI & Automation hub — provider API keys (encrypted at rest), optional custom
 * base URL + default model, and the on/off flag, per provider. A set
 * environment variable force-overrides and locks the matching key field.
 * Secrets are never sent to the browser; the page only reports whether each is
 * present (`configured`) and where it came from (`source`). Tabs: Réglages (the
 * provider cards) · Embeddings (the semantic-search provider + model, in their
 * own tab + action so a provider save can't blank them) · one prompt tab per
 * AI_FEATURES entry (so a new feature can never miss its tab).
 *
 * Gated by its OWN `requirePermission("system_ai", "view")` below — the admin
 * layout only checks admin-area access and does not isolate modules.
 */
export default async function AiSettingsPage() {
  const session = await requirePermission("system_ai", "view");
  // Saving providers/prompts/embeddings needs system_ai:update — gate the UI for
  // honesty (the save actions re-check server-side), mirroring the search page's
  // canManage pattern so a view-only role sees read-only controls, not a save
  // button that throws.
  const perms = await resolveUserPermissions(session.user.id);
  const canUpdate = permissionSetAllows(perms, "system_ai", "update");
  // Moving an env-keyed provider's base URL is owner-only (the workflow refuses
  // it for a delegate — the key would follow the URL); lock the field to match.
  const canEditBaseUrl = perms.has(WILDCARD);
  const [statuses, featureLoads, settingsMap] = await Promise.all([
    // Strict + no `.catch` (same for the settings map below): both pre-fill save
    // forms. A degraded read shows every provider disabled with no model (and
    // the embedding choice blank), which a normal save would persist over the
    // live config — a failure reaches the admin error boundary (retry) instead.
    listAiProviderStatus({ strict: true }),
    // A failed read must NOT look like "no overrides": the form would then save
    // blanks over real custom prompts. Flag it so that tab renders read-only.
    Promise.all(
      AI_FEATURES.map((f) =>
        aiFeaturePromptsService
          .listByFeature(f.id)
          .then((rows) => ({ rows, loadFailed: false }))
          .catch(() => ({ rows: [] as AiFeaturePromptRow[], loadFailed: true })),
      ),
    ),
    getSettingsMap(),
  ]);
  // Embedding provider/model — CMS settings (not provider rows), read back by the
  // embedding chokepoint at runtime; "" = auto-pick / code default.
  const embeddingProvider = asStr(settingsMap["ai.embedding_provider"], "").trim();
  const embeddingModel = asStr(settingsMap["ai.embedding_model"], "").trim();
  // The catalog supplies the env-var name + docs link + key hint so the panel
  // can render the lock badge ("Défini via <ENV_VAR>") and docs link.
  const byId = new Map(AI_PROVIDERS.map((p) => [p.id, p]));

  const providers: AiProviderCardData[] = statuses.map((s) => {
    const def = byId.get(s.id);
    return {
      id: s.id,
      label: s.label,
      enabled: s.enabled,
      configured: s.configured,
      source: s.source,
      envLocked: s.envLocked,
      apiKeyEnv: def?.apiKeyEnv ?? "",
      baseUrl: s.baseUrl,
      defaultModel: s.defaultModel,
      baseUrlPlaceholder: def?.defaultBaseUrl ?? s.baseUrl,
      docsUrl: def?.docsUrl,
      keyHint: def?.keyHint,
    };
  });

  // Only configured + enabled providers can actually run a generation, so the
  // per-task provider <select> is seeded with those (plus an empty "Par défaut"
  // option added in the panel). Empty list ⇒ prompts still editable.
  const providerOptions: ProviderOption[] = statuses
    .filter((s) => s.configured && s.enabled)
    .map((s) => ({ value: s.id, label: s.label }));

  // Merge each feature's task catalog (code defaults) with stored overrides. The
  // textarea is prefilled with the stored OVERRIDE only ("" when none); the code
  // default travels separately (placeholder + « Partir du prompt par défaut »),
  // so an untouched task saves as NULL and keeps following tasks.ts updates. A
  // legacy row that pinned the exact default is shown as « par défaut » too.
  const samePrompt = (a: string, b: string) =>
    a.replace(/\r\n?/g, "\n").trim() === b.replace(/\r\n?/g, "\n").trim();
  const mergeTasks = (feature: AiFeature, rows: AiFeaturePromptRow[]): FeatureTaskData[] => {
    const byTask = new Map(rows.map((r) => [r.task, r]));
    return feature.tasks.map((t) => {
      const row = byTask.get(t.id);
      const stored = row?.system_prompt?.trim() ?? "";
      return {
        id: t.id,
        label: t.label,
        description: t.description,
        kind: t.kind,
        customPrompt: stored && !samePrompt(stored, t.defaultSystemPrompt) ? stored : "",
        defaultSystemPrompt: t.defaultSystemPrompt,
        provider: row?.provider ?? "",
        model: row?.model ?? "",
        enabled: row?.enabled ?? true,
      };
    });
  };
  const features: FeaturePromptsData[] = AI_FEATURES.map((f, i) => ({
    id: f.id,
    label: f.label,
    tasks: mergeTasks(f, featureLoads[i]?.rows ?? []),
    loadFailed: featureLoads[i]?.loadFailed ?? true,
  }));

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/system"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-3 w-3" /> Retour au Système
        </Link>
        <div className="mt-2">
          <AdminPageHeader
            title="IA & Automation"
            description="Clés API des fournisseurs d'IA (OpenRouter, DeepSeek, OpenAI, Claude), chiffrées en base. Ces identifiants alimentent les fonctions d'IA & d'automatisation : génération de contenu (produits, catégories, marques, collections), catégorisation, affectation marques/attributs, produits complémentaires, avis. Elles sont lues via un point d'accès unique mis en cache. Une variable d'environnement définie a la priorité et verrouille le champ correspondant."
          />
        </div>
      </div>

      <AiSettingsPanel
        providers={providers}
        features={features}
        providerOptions={providerOptions}
        embeddingProvider={embeddingProvider}
        embeddingModel={embeddingModel}
        canUpdate={canUpdate}
        canEditBaseUrl={canEditBaseUrl}
      />
    </div>
  );
}
