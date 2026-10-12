/**
 * PURE search-engine config parsing — no "server-only", no DB import, so it can
 * be unit-tested directly (mirrors src/lib/tracking/parse-config.ts and
 * src/lib/seo/settings-normalize.ts). The async loader lives in config.ts,
 * which re-exports everything here.
 *
 * Every storefront/admin reader pulls its tuning from one resolved object so
 * search behaviour has a single source of truth. All keys live under the
 * `search.` prefix and are RUNTIME-DEFAULTED (no seed migration) — exactly like
 * `pages.recherche.*`: an empty settings map yields today's hard-coded values.
 */

import { asBool } from "@/lib/cms/setting-coerce";
import type { SearchKind } from "./types";

export type SearchConfig = {
  /** Min trimmed query length before the engine runs at all. */
  minQueryLength: number;
  /** pg_trgm similarity floor for the typo-recovery branch (0–1). */
  trigramThreshold: number;
  /** α — weight applied to the FTS ts_rank_cd term. */
  weightName: number;
  /** β — weight applied to the trigram similarity term. */
  weightDesc: number;
  /**
   * Semantic (vector) search master switch. Default OFF — with it off (or no
   * embedding provider / no product vectors) product search is byte-for-byte the
   * FTS+trigram query. Requires the embedding backfill + a provider configured in
   * Système → IA to have any effect.
   */
  semanticEnabled: boolean;
  /** δ — weight applied to the vector cosine-similarity term (only when semantic on). */
  weightSemantic: number;
  /**
   * Cosine-similarity FLOOR (0–0.9) a product must reach to be recalled by the
   * vector branch ALONE. Without it the KNN always unions its nearest neighbours —
   * even for gibberish — so every query "finds" products and the zero-result report
   * (→ alias workflow) goes permanently empty. Keyword hits are never dropped by it.
   */
  semanticMinSimilarity: number;
  /** Per-kind on/off toggles (a disabled kind is never queried). */
  kinds: Record<SearchKind, boolean>;
  /** Per-kind cap on the /recherche results page. */
  resultLimit: number;
  /** Per-kind cap for the autocomplete API default. */
  autocompleteLimit: number;
  /**
   * Out-of-stock product handling:
   *   true  (default) — SHOW out-of-stock products: the top results are picked
   *                     by relevance (`ORDER BY score DESC, in_stock DESC`), then
   *                     in-stock hits are listed before out-of-stock ones among
   *                     those top results. Never hides, so discovery / SEO is
   *                     preserved (the 2026-recommended default).
   *   false           — EXCLUDE out-of-stock products from product search
   *                     (`WHERE in_stock = true`). A deliberate operator opt-in.
   */
  showOutOfStock: boolean;
  /** Search-log retention window in months, fed to the auto-purge job. */
  purgeMonths: number;
};

export const SEARCH_KINDS: SearchKind[] = [
  "product",
  "category",
  "brand",
  "blog_post",
  "page",
];

export const SEARCH_DEFAULTS: SearchConfig = {
  minQueryLength: 2,
  trigramThreshold: 0.3,
  weightName: 2,
  weightDesc: 1,
  semanticEnabled: false,
  weightSemantic: 1,
  semanticMinSimilarity: 0.35,
  kinds: {
    product: true,
    category: true,
    brand: true,
    blog_post: true,
    page: true,
  },
  resultLimit: 24,
  autocompleteLimit: 6,
  showOutOfStock: true,
  purgeMonths: 3,
};

/** Parse a textual number, falling back when absent / empty / non-finite. */
function num(v: string | null | undefined, fallback: number): number {
  if (v == null) return fallback;
  const t = v.trim();
  // Number("") is 0 (not NaN) — treat blank as "unset" so it uses the default.
  if (t === "") return fallback;
  const n = Number(t);
  return Number.isFinite(n) ? n : fallback;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(n, hi));

const clampInt = (n: number, lo: number, hi: number): number =>
  clamp(Math.round(n), lo, hi);

/**
 * Resolve a SearchConfig from an already-fetched settings map (no DB call).
 * Every numeric value is clamped to a safe range so an operator typo (or a
 * hand-edited setting row) can never produce a pathological query plan
 * (runaway LIMIT, negative weight, threshold outside 0–1, …).
 */
export function resolveSearchConfig(
  s: Record<string, string | null>,
): SearchConfig {
  const kinds = {} as Record<SearchKind, boolean>;
  for (const k of SEARCH_KINDS) {
    kinds[k] = asBool(s[`search.kind_${k}`], SEARCH_DEFAULTS.kinds[k]);
  }
  return {
    minQueryLength: clampInt(num(s["search.min_query_length"], SEARCH_DEFAULTS.minQueryLength), 1, 4),
    trigramThreshold: clamp(num(s["search.trigram_threshold"], SEARCH_DEFAULTS.trigramThreshold), 0.1, 0.6),
    weightName: clamp(num(s["search.weight_name"], SEARCH_DEFAULTS.weightName), 0, 10),
    // NOTE: despite the `weight_desc`/`weightDesc` name, this β actually weights
    // NAME/title trigram SIMILARITY (not description) in the ranking formula (see
    // search/queries.ts). Legacy key kept — renaming it would need a settings
    // migration; the French admin UI label already describes it correctly.
    weightDesc: clamp(num(s["search.weight_desc"], SEARCH_DEFAULTS.weightDesc), 0, 10),
    semanticEnabled: asBool(s["search.semantic_enabled"], SEARCH_DEFAULTS.semanticEnabled),
    weightSemantic: clamp(num(s["search.weight_semantic"], SEARCH_DEFAULTS.weightSemantic), 0, 10),
    semanticMinSimilarity: clamp(
      num(s["search.semantic_min_similarity"], SEARCH_DEFAULTS.semanticMinSimilarity),
      0,
      0.9,
    ),
    kinds,
    resultLimit: clampInt(num(s["search.result_limit"], SEARCH_DEFAULTS.resultLimit), 1, 50),
    autocompleteLimit: clampInt(num(s["search.autocomplete_limit"], SEARCH_DEFAULTS.autocompleteLimit), 1, 25),
    showOutOfStock: asBool(s["search.show_out_of_stock"], SEARCH_DEFAULTS.showOutOfStock),
    purgeMonths: clampInt(num(s["search.purge_months"], SEARCH_DEFAULTS.purgeMonths), 1, 24),
  };
}

/**
 * The numeric sub-config threaded into the low-level `queries.ts` readers.
 * Kept narrow so the SQL builders depend only on the scoring knobs, not the
 * whole config (kinds/limits/purge are the service's concern).
 */
export type SearchQueryConfig = {
  weightName: number;
  weightDesc: number;
  trigramThreshold: number;
  showOutOfStock: boolean;
  /** Semantic master switch — forces the vector fragments to no-op SQL when false. */
  semanticEnabled: boolean;
  /** δ — vector cosine-similarity weight in the hybrid score. */
  weightSemantic: number;
  /** Cosine floor for vector-only recall (keyword hits are never floored). */
  semanticMinSimilarity: number;
};

export function toQueryConfig(cfg: SearchConfig): SearchQueryConfig {
  return {
    weightName: cfg.weightName,
    weightDesc: cfg.weightDesc,
    trigramThreshold: cfg.trigramThreshold,
    showOutOfStock: cfg.showOutOfStock,
    semanticEnabled: cfg.semanticEnabled,
    weightSemantic: cfg.weightSemantic,
    semanticMinSimilarity: cfg.semanticMinSimilarity,
  };
}

/**
 * Upper bound on a search query's length (characters, after trimming). Real
 * shopper queries are a few words; a multi-KB `?q=` only exists to make every
 * reader run websearch_to_tsquery + a trigram `%` / similarity() over a huge
 * operand on six tables (and bloat search_log). Applied at the service chokepoint
 * (covers /recherche AND the autocomplete API) and by the page before display.
 */
export const MAX_SEARCH_QUERY_LENGTH = 150;

/**
 * Trim + cap a raw query at {@link MAX_SEARCH_QUERY_LENGTH}. Never leaves a lone
 * high surrogate at the cut (an emoji split in half would be an invalid string in
 * the SQL param / the page title). Idempotent: clamping twice changes nothing.
 */
export function clampSearchQuery(raw: string): string {
  const t = raw.trim();
  if (t.length <= MAX_SEARCH_QUERY_LENGTH) return t;
  let s = t.slice(0, MAX_SEARCH_QUERY_LENGTH);
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  return s.trim();
}

/** Postgres' built-in pg_trgm.similarity_threshold — what the `%` operator uses by default. */
export const PG_DEFAULT_TRGM_THRESHOLD = 0.3;

/**
 * Whether a configured trigram threshold differs from PG's built-in default and
 * therefore needs the per-request `set_config` GUC. At the default the search
 * engine uses plain pooled queries (no transaction, no extra connections held);
 * see `runSearchReaders` in queries.ts. The epsilon guards against float drift
 * (e.g. a stored "0.30000000001" must still count as "default").
 */
export function needsTrigramTx(threshold: number): boolean {
  return Math.abs(threshold - PG_DEFAULT_TRGM_THRESHOLD) >= 1e-9;
}
