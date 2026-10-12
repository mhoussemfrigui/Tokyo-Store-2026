"use client";

import { useActionState } from "react";
import { Loader2, Lock, Save } from "lucide-react";
import { AdminCallout } from "@/components/admin/_components/filter-bar";

import { FieldSection, NumberField, ToggleField } from "@/components/admin/_components/setting-fields";
import { saveSemanticSettingsAction } from "@/lib/actions/search-settings";
import { type SearchConfig } from "@/modules/search/parse-config";
import { type ActionState } from "@/lib/actions/types";

/**
 * The « Sémantique » tab's settings form — the search-side knobs for vector search
 * (`search.semantic_enabled` + `search.weight_semantic` +
 * `search.semantic_min_similarity`). Its OWN <form> +
 * action (saveSemanticSettingsAction), separate from the Réglages form so neither
 * clobbers the other's fields. The embedding PROVIDER + MODEL live in Système → IA & Automation
 * → onglet Embeddings (they're AI infra); the « Vectoriser le catalogue » backfill panel sits
 * alongside this form in the same tab.
 */
export function SemanticSettingsForm({
  values,
  canManage,
}: {
  values: SearchConfig;
  canManage: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveSemanticSettingsAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-8">
      {!canManage && (
        <AdminCallout tone="warning" icon={Lock}>
          Lecture seule — la permission «&nbsp;gérer&nbsp;» est requise pour modifier ces réglages.
        </AdminCallout>
      )}
      <fieldset disabled={!canManage} className="m-0 min-w-0 space-y-8 border-0 p-0">
        <FieldSection
          title="Recherche sémantique (IA)"
          description="La recherche vectorielle (pgvector) trouve les produits par le SENS, pas seulement par mots-clés — « montre de plongée » remonte un « diver automatique », « chrono acier » privilégie les CHRONOGRAPHES en acier sur les bracelets. Nécessite un fournisseur d'embeddings configuré dans Système → IA & Automation → onglet Embeddings, puis la vectorisation du catalogue (ci-dessous). Sans effet tant qu'elle est désactivée : la recherche reste identique."
        >
          <ToggleField
            name="search.semantic_enabled"
            label="Activer la recherche sémantique"
            description="Ajoute la similarité de sens (vecteurs) à la page /recherche, en complément des mots-clés. À activer une fois le catalogue vectorisé."
            defaultChecked={values.semanticEnabled}
          />
          <NumberField
            name="search.weight_semantic"
            label="Poids sémantique"
            defaultValue={String(values.weightSemantic)}
            min={0}
            max={10}
            step={0.5}
            helper="Importance de la similarité de sens dans le score (0 à 10 ; 0 n'utilise le vectoriel que pour élargir les résultats — au-delà de la similarité minimale ci-dessous — sans peser sur le classement). Par défaut : 1. Baissez-le si des bracelets/accessoires remontent trop haut ; montez-le pour privilégier le sens."
          />
          <NumberField
            name="search.semantic_min_similarity"
            label="Similarité minimale"
            defaultValue={String(values.semanticMinSimilarity)}
            min={0}
            max={0.9}
            step={0.05}
            helper="Seuil de similarité de sens (0 à 0,9) qu'un produit doit atteindre pour être ajouté aux résultats par le vectoriel SEUL. Les produits trouvés par mots-clés restent toujours affichés. Plus haut = moins de résultats hors sujet et des recherches sans résultat qui remontent dans les statistiques (utile pour créer des alias) ; plus bas = rappel plus large. Par défaut : 0,35."
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Après un changement de modèle d&apos;embeddings (Système → IA &amp; Automation → Embeddings), seuls
            les produits revectorisés avec le nouveau modèle participent à la recherche
            sémantique&nbsp;: relancez «&nbsp;Vectoriser le catalogue&nbsp;» ci-dessous. En
            attendant, la recherche par mots-clés reste active.
          </p>
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
