"use server";

import { revalidatePath } from "next/cache";

import { workflows } from "@/workflows";
import { requirePermission } from "@/lib/auth/session";
import { type ActionState } from "@/lib/actions/types";
import { resolveSearchConfig, SEARCH_KINDS } from "@/modules/search/parse-config";

/**
 * Persist the search-engine tuning (`search.*` site_settings) from the
 * "Recherche → Réglages" form. Mirrors saveAnalyticsSettingsAction:
 * requirePermission → upsert each key → revalidate.
 *
 * Validation reuses `resolveSearchConfig` — the SAME pure resolver the engine
 * reads — so what we persist is already clamped to safe ranges (a hand-typed
 * `weight: 999` or `threshold: -1` can never reach the query planner).
 */

const FR_KIND_LABEL: Record<(typeof SEARCH_KINDS)[number], string> = {
  product: "Produits",
  category: "Catégories",
  brand: "Marques",
  blog_post: "Articles blog",
  page: "Pages",
};

export async function saveSearchSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_search", "manage");

  // Build a raw settings map from the posted form, then normalize through the
  // resolver so persisted values are clamped/rounded exactly like the engine
  // would interpret them.
  const raw: Record<string, string | null> = {
    "search.min_query_length": String(formData.get("search.min_query_length") ?? ""),
    "search.trigram_threshold": String(formData.get("search.trigram_threshold") ?? ""),
    "search.weight_name": String(formData.get("search.weight_name") ?? ""),
    "search.weight_desc": String(formData.get("search.weight_desc") ?? ""),
    "search.result_limit": String(formData.get("search.result_limit") ?? ""),
    "search.autocomplete_limit": String(formData.get("search.autocomplete_limit") ?? ""),
    "search.purge_months": String(formData.get("search.purge_months") ?? ""),
    "search.show_out_of_stock":
      formData.get("search.show_out_of_stock") === "on" ? "true" : "false",
  };
  for (const k of SEARCH_KINDS) {
    raw[`search.kind_${k}`] = formData.get(`search.kind_${k}`) === "on" ? "true" : "false";
  }

  const cfg = resolveSearchConfig(raw);

  const numberEntries: Array<{ key: string; value: string; label: string }> = [
    { key: "search.min_query_length", value: String(cfg.minQueryLength), label: "Recherche — longueur minimale de la requête" },
    { key: "search.trigram_threshold", value: String(cfg.trigramThreshold), label: "Recherche — seuil de similarité (typo)" },
    { key: "search.weight_name", value: String(cfg.weightName), label: "Recherche — poids du texte intégral" },
    { key: "search.weight_desc", value: String(cfg.weightDesc), label: "Recherche — poids de la similarité" },
    { key: "search.result_limit", value: String(cfg.resultLimit), label: "Recherche — résultats par type (page)" },
    { key: "search.autocomplete_limit", value: String(cfg.autocompleteLimit), label: "Recherche — suggestions par type (autocomplétion)" },
    { key: "search.purge_months", value: String(cfg.purgeMonths), label: "Recherche — conservation du journal (mois)" },
  ];

  for (const e of numberEntries) {
    const res = await workflows.cms.upsertSetting(
      {
        key: e.key,
        value: e.value,
        type: "text" as never,
        groupKey: "search",
        label: e.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  const boolEntries: Array<{ key: string; value: boolean; label: string }> = [
    {
      key: "search.show_out_of_stock",
      value: cfg.showOutOfStock,
      label: "Recherche — afficher les produits en rupture de stock",
    },
    ...SEARCH_KINDS.map((k) => ({
      key: `search.kind_${k}`,
      value: cfg.kinds[k],
      label: `Recherche — type recherchable : ${FR_KIND_LABEL[k]}`,
    })),
  ];

  for (const e of boolEntries) {
    const res = await workflows.cms.upsertSetting(
      {
        key: e.key,
        value: e.value ? "true" : "false",
        type: "boolean" as never,
        groupKey: "search",
        label: e.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  // Admin dashboard + the live storefront search page both read these.
  revalidatePath("/admin/system/search");
  revalidatePath("/recherche");
  return { ok: true, message: "Réglages de recherche enregistrés." };
}

/**
 * Persist ONLY the semantic-search knobs (its own « Sémantique » form).
 * Kept SEPARATE from saveSearchSettingsAction so the two forms write DISJOINT key
 * sets — otherwise saving the Réglages tab (which doesn't render the semantic
 * fields) would reset them to defaults. Validated through the same pure
 * resolveSearchConfig clamping. Gated on system_search:manage. The embedding
 * provider/model live in Système → IA & Automation, not here.
 */
export async function saveSemanticSettingsAction(
  _prev: ActionState | null,
  formData: FormData,
): Promise<ActionState> {
  const session = await requirePermission("system_search", "manage");
  const cfg = resolveSearchConfig({
    "search.semantic_enabled": formData.get("search.semantic_enabled") === "on" ? "true" : "false",
    "search.weight_semantic": String(formData.get("search.weight_semantic") ?? ""),
    "search.semantic_min_similarity": String(formData.get("search.semantic_min_similarity") ?? ""),
  });

  const entries = [
    {
      key: "search.semantic_enabled",
      value: cfg.semanticEnabled ? "true" : "false",
      type: "boolean",
      label: "Recherche — recherche sémantique (vectorielle)",
    },
    {
      key: "search.weight_semantic",
      value: String(cfg.weightSemantic),
      type: "text",
      label: "Recherche — poids sémantique (vectoriel)",
    },
    {
      key: "search.semantic_min_similarity",
      value: String(cfg.semanticMinSimilarity),
      type: "text",
      label: "Recherche — similarité minimale (vectoriel seul)",
    },
  ] as const;
  for (const e of entries) {
    const res = await workflows.cms.upsertSetting(
      {
        key: e.key,
        value: e.value,
        type: e.type as never,
        groupKey: "search",
        label: e.label,
      },
      { actorUserId: session.user.id },
    );
    if (!res.ok) return { ok: false, error: res.error, message: res.message };
  }

  revalidatePath("/admin/system/search");
  revalidatePath("/recherche");
  return { ok: true, message: "Réglages sémantiques enregistrés." };
}
