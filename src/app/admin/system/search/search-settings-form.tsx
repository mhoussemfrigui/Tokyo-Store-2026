"use client";

import { useActionState } from "react";
import { Loader2, Lock, Save } from "lucide-react";
import { AdminCallout } from "@/components/admin/_components/filter-bar";

import {
  FieldSection,
  NumberField,
  ToggleField,
} from "@/components/admin/_components/setting-fields";
import { saveSearchSettingsAction } from "@/lib/actions/search-settings";
import { type SearchConfig } from "@/modules/search/parse-config";
import { type ActionState } from "@/lib/actions/types";

const KIND_FIELDS: ReadonlyArray<{
  kind: keyof SearchConfig["kinds"];
  label: string;
  description: string;
}> = [
  { kind: "product", label: "Produits", description: "Le catalogue (toujours recommandé)." },
  { kind: "category", label: "Catégories", description: "Les pages de catégorie." },
  { kind: "brand", label: "Marques", description: "Les pages de marque." },
  { kind: "blog_post", label: "Articles blog", description: "Les articles publiés du blog." },
  { kind: "page", label: "Pages", description: "Les pages de contenu (CGV, à propos…)." },
];

/**
 * "Réglages" panel of the Recherche control center. A single self-contained
 * settings form (its own `<form>`) — the Statistiques / Purge tabs are not
 * forms, so unlike the analytics panel we do NOT wrap the whole control center.
 * Values are persisted + re-clamped by `saveSearchSettingsAction`.
 */
export function SearchSettingsForm({
  values,
  canManage,
}: {
  values: SearchConfig;
  canManage: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState | null, FormData>(
    saveSearchSettingsAction,
    null,
  );

  return (
    <form action={formAction} className="space-y-8">
      {!canManage && (
        <AdminCallout tone="warning" icon={Lock}>
          Lecture seule — la permission « gérer » est requise pour modifier ces
          réglages.
        </AdminCallout>
      )}
      {/* A disabled fieldset natively disables every nested input, so a
          view-only operator sees the values but can't edit or submit them
          (the action also re-checks system_search:manage server-side). */}
      <fieldset disabled={!canManage} className="m-0 min-w-0 space-y-8 border-0 p-0">
      <FieldSection
        title="Pertinence"
        description="Comment les résultats sont notés et classés. Le score combine la recherche plein-texte (FTS) et la similarité approximative (récupération de fautes de frappe)."
      >
        <NumberField
          name="search.min_query_length"
          label="Longueur minimale de la requête"
          defaultValue={String(values.minQueryLength)}
          min={1}
          max={4}
          step={1}
          helper="Nombre de caractères avant de lancer une recherche (1 à 4). Par défaut : 2."
        />
        <NumberField
          name="search.trigram_threshold"
          label="Seuil de similarité (fautes de frappe)"
          defaultValue={String(values.trigramThreshold)}
          min={0.1}
          max={0.6}
          step={0.1}
          helper="Tolérance aux fautes de frappe (0,1 à 0,6). Plus bas = plus tolérant (plus de résultats approximatifs) ; plus haut = plus strict. Par défaut : 0,3."
        />
        <NumberField
          name="search.weight_name"
          label="Poids du texte intégral (FTS)"
          defaultValue={String(values.weightName)}
          min={0}
          max={10}
          step={0.5}
          helper="Importance des correspondances sémantiques/plein-texte dans le score (0 à 10). Par défaut : 2."
        />
        <NumberField
          name="search.weight_desc"
          label="Poids de la similarité"
          defaultValue={String(values.weightDesc)}
          min={0}
          max={10}
          step={0.5}
          helper="Importance de la similarité approximative (fautes de frappe) dans le score (0 à 10). Par défaut : 1."
        />
      </FieldSection>

      <FieldSection
        title="Types recherchables"
        description="Les types de contenu interrogés. Un type désactivé n'apparaît ni dans l'autocomplétion ni sur la page de résultats."
      >
        {KIND_FIELDS.map((f) => (
          <ToggleField
            key={f.kind}
            name={`search.kind_${f.kind}`}
            label={f.label}
            description={f.description}
            defaultChecked={values.kinds[f.kind]}
          />
        ))}
      </FieldSection>

      <FieldSection
        title="Affichage"
        description="Le nombre de résultats affichés et le traitement des produits en rupture de stock."
      >
        <NumberField
          name="search.result_limit"
          label="Résultats par type (page de résultats)"
          defaultValue={String(values.resultLimit)}
          min={1}
          max={50}
          step={1}
          helper="Nombre de résultats par type sur la page /recherche (1 à 50). Par défaut : 24."
        />
        <NumberField
          name="search.autocomplete_limit"
          label="Suggestions par type (autocomplétion)"
          defaultValue={String(values.autocompleteLimit)}
          min={1}
          max={25}
          step={1}
          helper="Nombre de suggestions par type dans le menu déroulant de l'en-tête (1 à 25). Par défaut : 6."
        />
        <ToggleField
          name="search.show_out_of_stock"
          label="Afficher les produits en rupture de stock"
          description="Activé : les produits en rupture restent visibles mais sont classés après les produits en stock (préserve le référencement). Désactivé : ils sont exclus des résultats produits."
          defaultChecked={values.showOutOfStock}
        />
      </FieldSection>

      <FieldSection
        title="Rétention"
        description="Le journal de recherche alimente les statistiques. La purge automatique quotidienne (Tâches planifiées) supprime les lignes plus anciennes que cette fenêtre."
      >
        <NumberField
          name="search.purge_months"
          label="Conservation du journal de recherche (mois)"
          defaultValue={String(values.purgeMonths)}
          min={1}
          max={24}
          step={1}
          helper="Durée de conservation des statistiques de recherche (1 à 24 mois). Par défaut : 3 mois."
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
