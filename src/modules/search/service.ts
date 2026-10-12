import "server-only";

import { asc, eq, sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/pg-errors";
import { enrichProductSearchHits } from "@/lib/api/products";
import { ttlCached } from "@/lib/cache/ttl";
import { bustCacheTag } from "@/lib/cache/revalidate";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { generateEmbedding, resolveEmbeddingTarget, EMBEDDING_DIM } from "@/lib/ai/embed";
import { search_log, search_aliases, type SearchAliasRow } from "./schema";
import { expandSearchQuery, type SearchAlias } from "./aliases";
import { DEFAULT_SEARCH_ALIASES } from "./default-aliases";
import { clampSearchQuery, getSearchConfig, toQueryConfig, type SearchConfig } from "./config";
import { embeddingHashPrefix } from "./embed-input";
import type { SearchKind } from "./types";
import {
  getOverviewStats,
  getTopQueries,
  getZeroResultQueries,
  runSearchReaders,
  searchBlogPosts,
  searchBrands,
  searchCategories,
  searchPages,
  searchProducts,
  type ProductSearchHit,
  type SearchHit,
  type SearchOverviewStats,
} from "./queries";

/**
 * Public search service.
 *
 * Entry point for both the storefront API route and the /recherche
 * page. Fans out across the searchable modules in parallel, merges +
 * dedupes the results, fires off a non-blocking telemetry write and
 * returns the page to the caller. The whole thing is one ~80 ms p95
 * end-to-end at 1M-row scale because every reader hits a GIN (FTS) or
 * trigram-GIN (typo fallback) index.
 *
 * Hybrid scoring (today)
 * ──────────────────────
 *   score = α · ts_rank_cd(search_vector, websearch_to_tsquery(q))
 *         + β · similarity(name|title, raw_q)
 *
 *   Defaults: α = 2 (FTS rank — semantic, weighted), β = 1 (trigram —
 *   syntactic typo recovery). Tuned empirically against the seed catalog.
 *
 * Semantic (pgvector) recall — SHIPPED, opt-in
 * ────────────────────────────────────────────
 * When the caller opts in (`opts.semantic`, i.e. /recherche — autocomplete never
 * embeds per keystroke), the master switch `search.semantic_enabled` is on, and
 * products are in scope, the query is embedded (via `resolveEmbeddingTarget` +
 * `generateEmbedding`, TTL-cached per model+query) and threaded to `searchProducts`,
 * which unions a vector-KNN recall (only neighbours at or above
 * `search.semantic_min_similarity`, embedded with the live model) into the
 * FTS+trigram set and blends the cosine similarity into the score:
 *
 *   score = α · ts_rank_cd + β · trigram_sim + δ · cosine_sim
 *
 * OFF, unconfigured, or with the products.embedding column still empty ⇒ the product
 * query is byte-for-byte the keyword-only query above (safe-by-default). See
 * modules/search/queries.ts (the SEMANTIC block) + modules/search/embedding.service.ts
 * (the ingestion pipeline).
 */

// Re-export the canonical (pure) kind union so `from "./service"` importers
// (e.g. the module barrel) keep resolving it.
export type { SearchKind };

export type SearchOpts = {
  /**
   * Per-kind cap (1–50). The merged `hits` payload is the concatenation of all
   * enabled kinds (six max) with no separate overall cap; `page` is additionally
   * capped at min(limit, 5).
   */
  limit?: number;
  /** Restrict to a subset of kinds. Default: all. */
  kinds?: SearchKind[];
  /**
   * Opt IN to semantic (vector) recall for this search. Only /recherche sets it;
   * autocomplete leaves it off so it never embeds per keystroke. Requires the
   * `search.semantic_enabled` master switch AND an embedding provider to have any
   * effect — otherwise it's a silent no-op (keyword-only).
   */
  semantic?: boolean;
  /**
   * Pre-computed query embedding (length {@link EMBEDDING_DIM}). When supplied it
   * wins over embedding the query here (skips the API call); otherwise `search()`
   * embeds the query itself when `semantic` is on. Any other length is ignored.
   */
  embedding?: number[];
  /** Used by `search()` to attribute log rows. */
  userId?: string | null;
  /** Used by `search()` to attribute log rows. */
  ip?: string | null;
  /** Skip writing a search_log row (admin / preview). */
  skipLog?: boolean;
  /**
   * Pre-resolved search config. Callers that already read it for their own UI
   * (e.g. /recherche resolves it to size the results grid) pass it through to
   * avoid a redundant resolve; omit it and `search()` loads it itself (the
   * underlying settings read is React-cached, so either way is one DB hit).
   */
  config?: SearchConfig;
};

export type SearchResultPage = {
  query: string;
  total: number;
  hits: SearchHit[];
  products: ProductSearchHit[];
  categories: SearchHit[];
  brands: SearchHit[];
  blog_posts: SearchHit[];
  pages: SearchHit[];
};

/**
 * Query-embedding cache — a process-level TTL memo over `generateEmbedding`, keyed
 * by (model, query). The SAME query string always embeds to the SAME vector, so an
 * hour's cache turns repeat /recherche queries into zero API calls (≤1000 distinct
 * queries, FIFO). The `model` is part of the KEY (not used in the body — the
 * chokepoint resolves the live provider+model itself) so switching the embedding
 * model busts cached query vectors — otherwise a shopper could get OLD-model query
 * vectors compared against NEW-model product vectors (mismatched space) for the TTL.
 * A failed embed THROWS (never cached), so the caller's `.catch(() => [])` degrades
 * that one request to keyword-only and the next request retries.
 */
const loadQueryEmbedding = ttlCached(
  async (_model: string, query: string): Promise<number[]> => {
    const r = await generateEmbedding(query);
    if (!r.ok) throw new Error(r.error);
    return r.embedding;
  },
  { ttlMs: 60 * 60_000, key: (m, q) => `${m}\n${q}`, max: 1000 },
);

/**
 * The ACTIVE alias set, TTL-cached across requests (loaded on every storefront
 * search + autocomplete keystroke, so a per-request React cache wouldn't spare the
 * keystroke-rate DB hits). The set is tiny; an admin edit busts
 * `CACHE_TAGS.searchAliases` (via bustCacheTag → clearTtlCache) so a new rule
 * expands queries on the very next search. Best-effort at the call site.
 */
const loadActiveAliases = ttlCached(
  async (): Promise<SearchAlias[]> =>
    db
      .select({ term: search_aliases.term, expansion: search_aliases.expansion })
      .from(search_aliases)
      .where(eq(search_aliases.is_active, true)),
  { ttlMs: 5 * 60_000, tags: [CACHE_TAGS.searchAliases], key: () => "_" },
);

class SearchService {
  /**
   * Multi-table search. Returns a grouped page and a merged-sorted list
   * for the autocomplete dropdown.
   */
  async search(query: string, opts: SearchOpts = {}): Promise<SearchResultPage> {
    // Trim + cap the length HERE (the single chokepoint for /recherche AND the
    // autocomplete API) so an adversarial multi-KB `?q=` never reaches the six
    // FTS/trigram readers, the embedding call or search_log.
    const trimmed = clampSearchQuery(query);
    // Resolve the admin-tunable config once (settings read is React-cached, so
    // a caller that already resolved it can pass it via opts.config).
    const cfg = opts.config ?? (await getSearchConfig());
    if (trimmed.length < cfg.minQueryLength) return emptyPage(trimmed);

    // ALIAS / SYNONYM expansion (0114): resolve the normalized query against the
    // active rules → extra query phrases the readers OR into the tsquery, so e.g.
    // « chrono acier » also finds « chronographe acier ». Widens FTS recall only;
    // the raw query still drives trigram + name scoring. Best-effort — a degraded
    // alias table must never break the search box. Empty (no rules) ⇒ unchanged query.
    const aliases = await loadActiveAliases().catch(() => [] as SearchAlias[]);
    const expansions =
      aliases.length > 0 ? expandSearchQuery(this.normalizeQuery(trimmed), aliases) : [];

    // Cap matches the readers' MAX_LIMIT (50) so the configured result_limit
    // (clamped 1–50) is honoured on /recherche; autocomplete callers pass the
    // already-1–25-clamped autocompleteLimit, so the dropdown stays bounded.
    const perKind = Math.max(1, Math.min(opts.limit ?? cfg.autocompleteLimit, 50));
    const queryCfg = toQueryConfig(cfg);
    const allKinds: SearchKind[] = [
      "product",
      "category",
      "brand",
      "blog_post",
      "page",
    ];
    // Intersect the caller-requested kinds with the admin per-kind toggles — a
    // kind switched off in Réglages is never queried (and returns []).
    const requested = opts.kinds ?? allKinds;
    const kinds = allKinds.filter((k) => requested.includes(k) && cfg.kinds[k]);

    // Semantic (pgvector) query embedding — resolved ONLY when the caller opted in
    // (opts.semantic, i.e. /recherche), the master switch is on, and products are in
    // scope. A supplied opts.embedding of the right dimension wins (no API call); else
    // we embed the query (TTL-cached, best-effort). [] ⇒ the reader stays keyword-only,
    // so a missing provider / failed embed silently degrades to today's search.
    let queryEmbedding: number[] = [];
    // "<model>|" — the live model's fingerprint prefix, so the vector recall only
    // compares against product vectors embedded in the SAME space (see searchProducts).
    let embeddingModelPrefix: string | null = null;
    if (opts.semantic && cfg.semanticEnabled && kinds.includes("product")) {
      // Resolve the live provider+model first so the query embedding is cached PER MODEL
      // (a model change busts it) and we skip the embeddings call when no provider is set.
      const target = await resolveEmbeddingTarget().catch(() => null);
      if (target) {
        // embeddingHashPrefix = "<model>|<version>|" (model already `|`-stripped) —
        // keep only "<model>|": an input-schema version bump stays in the same space.
        const full = embeddingHashPrefix(target.model);
        embeddingModelPrefix = full.slice(0, full.indexOf("|") + 1);
      }
      if (opts.embedding && opts.embedding.length === EMBEDDING_DIM) {
        queryEmbedding = opts.embedding;
      } else if (target) {
        queryEmbedding = await loadQueryEmbedding(target.model, trimmed.toLowerCase()).catch(
          () => [] as number[],
        );
      }
    }

    // Build a lazy reader thunk per ENABLED kind, then let runSearchReaders
    // orchestrate the fan-out: PARALLEL on the pool at the default 0.3 threshold,
    // or ONE shared transaction (single connection) when the threshold is tuned
    // — so a tuned search no longer checks out up to 6 pooled connections at
    // once. A failing kind degrades to [] either way (graceful, never 500s).
    const thunks: Partial<Record<SearchKind, (exec: DbOrTx) => Promise<SearchHit[]>>> = {};
    if (kinds.includes("product"))
      thunks.product = (exec) =>
        searchProducts(
          trimmed,
          perKind,
          queryCfg,
          exec,
          expansions,
          queryEmbedding,
          embeddingModelPrefix,
        ) as Promise<SearchHit[]>;
    if (kinds.includes("category"))
      thunks.category = (exec) => searchCategories(trimmed, perKind, queryCfg, exec, expansions);
    if (kinds.includes("brand"))
      thunks.brand = (exec) => searchBrands(trimmed, perKind, queryCfg, exec, expansions);
    if (kinds.includes("blog_post"))
      thunks.blog_post = (exec) => searchBlogPosts(trimmed, perKind, queryCfg, exec, expansions);
    if (kinds.includes("page"))
      thunks.page = (exec) => searchPages(trimmed, Math.min(perKind, 5), queryCfg, exec, expansions);

    const grouped = await runSearchReaders(queryCfg.trigramThreshold, thunks);
    const products: SearchHit[] = grouped.product ?? [];
    const categories: SearchHit[] = grouped.category ?? [];
    const brands: SearchHit[] = grouped.brand ?? [];
    const blog_posts: SearchHit[] = grouped.blog_post ?? [];
    const pages: SearchHit[] = grouped.page ?? [];

    // Apply the live promotion engine to product hits so search shows the SAME
    // effective price as the listing cards / PDP / cart (raw `price_cents` from
    // the table would otherwise show the full pre-discount price). In place, so
    // both `products` and the merged `hits` (same object refs) reflect it.
    await enrichProductSearchHits(products as ProductSearchHit[]).catch((err) => {
      console.error("[search] promo price enrichment failed (non-fatal)", err);
    });

    // Merge for the "all" pane — sorted by score then by kind priority
    // (products first, then categories/brands, then editorial). Dedupe on
    // (kind, id) because a row can't appear twice anyway, but the guard
    // keeps the contract honest if/when synonyms map two kinds to the
    // same id space.
    const seen = new Set<string>();
    const merged: SearchHit[] = [];
    const pushUnique = (hit: SearchHit) => {
      const key = `${hit.kind}:${hit.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(hit);
    };
    for (const h of products) pushUnique(h);
    for (const h of categories) pushUnique(h);
    for (const h of brands) pushUnique(h);
    for (const h of blog_posts) pushUnique(h);
    for (const h of pages) pushUnique(h);
    merged.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

    const page: SearchResultPage = {
      query: trimmed,
      total: merged.length,
      hits: merged,
      products: products as ProductSearchHit[],
      categories,
      brands,
      blog_posts,
      pages,
    };

    // Fire-and-forget telemetry write. We never block the response on
    // the log insert — the API contract is "return search hits fast" and
    // a degraded `search_log` table shouldn't break the search box.
    if (!opts.skipLog) {
      this.logSearch({
        query: trimmed,
        resultCount: merged.length,
        userId: opts.userId ?? null,
        ip: opts.ip ?? null,
      }).catch((err) => {
        console.error("[search] log insert failed (non-fatal)", err);
      });
    }

    return page;
  }

  /**
   * Normalise a query for storage / aggregation:
   *   • lowercase
   *   • strip diacritics (NFD-decompose + drop combining marks)
   *   • collapse whitespace
   *   • trim
   *
   * Postgres' unaccent() does the heavy lift at query time; this runs in
   * JS so the GROUP BY column is stable regardless of input case / form.
   */
  normalizeQuery(raw: string): string {
    return raw
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Append-only insert. Trims the IP to a max length to keep adversarial
   * `X-Forwarded-For` bombs out of the column.
   */
  async logSearch(input: {
    query: string;
    resultCount: number;
    userId?: string | null;
    ip?: string | null;
  }): Promise<void> {
    const normalized = this.normalizeQuery(input.query);
    if (normalized.length === 0) return;
    await db.insert(search_log).values({
      query: input.query.slice(0, 500),
      normalized_query: normalized.slice(0, 500),
      result_count: input.resultCount,
      user_id: input.userId ?? null,
      ip: input.ip?.slice(0, 64) ?? null,
    });
  }

  /**
   * Admin analytics readers — proxied through so the admin pages have a
   * single import surface. The underlying queries are in `./queries`.
   */
  async getTopQueries(opts: { days?: number; limit?: number } = {}) {
    return getTopQueries(opts);
  }

  async getZeroResultQueries(opts: { days?: number; limit?: number } = {}) {
    return getZeroResultQueries(opts);
  }

  async getOverviewStats(opts: { days?: number } = {}): Promise<SearchOverviewStats> {
    return getOverviewStats(opts);
  }

  /* ─────────────────────────────────────────── Aliases / synonyms (0114) ── */

  /** Every alias rule for the admin table, ordered by term then expansion. */
  async listAliases(): Promise<SearchAliasRow[]> {
    return db
      .select()
      .from(search_aliases)
      .orderBy(asc(search_aliases.term), asc(search_aliases.expansion));
  }

  /** How many alias rows exist (drives the admin empty-state / « recharger » CTA). */
  async countAliases(): Promise<{ total: number; defaults: number }> {
    const [row] = await db
      .execute<{ total: number; defaults: number }>(
        sql`SELECT COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE source = 'default')::int AS defaults
            FROM search_aliases;`,
      )
      .then((r) => r.rows);
    return { total: Number(row?.total ?? 0), defaults: Number(row?.defaults ?? 0) };
  }

  /**
   * Create one rule. Both fields are NORMALIZED (same folding as a live query) so
   * the stored row matches what the shopper types. Idempotent on the (term,
   * expansion) unique — a duplicate is reported, not thrown (23505 would poison a
   * caller tx). Busts the alias cache so the rule is live on the next search.
   */
  async createAlias(input: {
    term: string;
    expansion: string;
    source?: "manual" | "default";
  }): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const term = this.normalizeQuery(input.term).slice(0, 120);
    const expansion = this.normalizeQuery(input.expansion).slice(0, 120);
    if (!term || !expansion) return { ok: false, error: "Le terme et l'équivalent sont requis." };
    if (term === expansion) return { ok: false, error: "Le terme et l'équivalent sont identiques." };
    const [row] = await db
      .insert(search_aliases)
      .values({ term, expansion, source: input.source ?? "manual" })
      .onConflictDoNothing()
      .returning({ id: search_aliases.id });
    bustCacheTag(CACHE_TAGS.searchAliases);
    if (!row) return { ok: false, error: "Cet alias existe déjà." };
    return { ok: true, id: row.id };
  }

  /** Patch a rule's fields and/or its active flag. A rename that would collide
   *  with an existing pair is reported (unique violation caught). */
  async updateAlias(
    id: string,
    input: { term?: string; expansion?: string; isActive?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const patch: Partial<{ term: string; expansion: string; is_active: boolean; updated_at: unknown }> =
      { updated_at: sql`now()` };
    if (input.term !== undefined) {
      const t = this.normalizeQuery(input.term).slice(0, 120);
      if (!t) return { ok: false, error: "Le terme est requis." };
      patch.term = t;
    }
    if (input.expansion !== undefined) {
      const e = this.normalizeQuery(input.expansion).slice(0, 120);
      if (!e) return { ok: false, error: "L'équivalent est requis." };
      patch.expansion = e;
    }
    if (patch.term !== undefined && patch.expansion !== undefined && patch.term === patch.expansion)
      return { ok: false, error: "Le terme et l'équivalent sont identiques." };
    if (input.isActive !== undefined) patch.is_active = input.isActive;
    try {
      await db.update(search_aliases).set(patch as never).where(eq(search_aliases.id, id));
    } catch (err) {
      // A term/expansion RENAME can collide with the (term,expansion) unique (23505)
      // — report that as a duplicate. Any OTHER failure (connection drop, deadlock,
      // timeout) is a real error: log it + return a generic message rather than a
      // misleading "duplicate". (Today only the toggle path is wired, so 23505 here
      // is latent — but the toggle must not mask a transient DB error as a duplicate.)
      if (isUniqueViolation(err)) return { ok: false, error: "Un alias identique existe déjà." };
      console.error("[search] updateAlias failed", err);
      return { ok: false, error: "Échec de la mise à jour de l'alias." };
    }
    bustCacheTag(CACHE_TAGS.searchAliases);
    return { ok: true };
  }

  /** Hard-delete a rule. */
  async deleteAlias(id: string): Promise<void> {
    await db.delete(search_aliases).where(eq(search_aliases.id, id));
    bustCacheTag(CACHE_TAGS.searchAliases);
  }

  /**
   * Seed the catalogue-derived DEFAULT rules (source='default'), idempotently:
   * ON CONFLICT DO NOTHING on the (term, expansion) unique, so re-running only
   * adds rules the operator hasn't already got (and never clobbers manual edits
   * or re-adds ones they deliberately deleted). Returns how many rows were inserted.
   */
  async seedDefaultAliases(): Promise<number> {
    const values = DEFAULT_SEARCH_ALIASES.map((a) => ({
      term: this.normalizeQuery(a.term).slice(0, 120),
      expansion: this.normalizeQuery(a.expansion).slice(0, 120),
      source: "default" as const,
    })).filter((v) => v.term && v.expansion && v.term !== v.expansion);
    if (values.length === 0) return 0;
    const rows = await db
      .insert(search_aliases)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: search_aliases.id });
    bustCacheTag(CACHE_TAGS.searchAliases);
    return rows.length;
  }

  /**
   * Admin / cron retention sweep — delete log rows older than `days`.
   *
   * Batched in `SEARCH_LOG_PURGE_BATCH_SIZE` chunks (no unbounded
   * `DELETE ... RETURNING` over the whole window) so each statement commits a
   * bounded WAL segment and stays under the role's 10s `statement_timeout`
   * even on a multi-million-row hot table. The cutoff sub-select rides the
   * `search_log_created_at_brin` index. Returns the total rows removed.
   */
  async purgeOlderThan(days: number): Promise<number> {
    const d = Math.max(7, Math.min(days, 730));
    const cutoff = new Date(Date.now() - d * 24 * 60 * 60 * 1000);
    let total = 0;
    for (;;) {
      const result = await db.execute<{ count: number }>(sql`
        WITH deleted AS (
          DELETE FROM search_log
          WHERE id IN (
            SELECT id FROM search_log
            WHERE created_at < ${cutoff}
            LIMIT ${SEARCH_LOG_PURGE_BATCH_SIZE}
          )
          RETURNING 1
        )
        SELECT COUNT(*)::int AS count FROM deleted;
      `);
      const deleted = Number(result.rows[0]?.count ?? 0);
      total += deleted;
      if (deleted < SEARCH_LOG_PURGE_BATCH_SIZE) break;
    }
    return total;
  }
}

/**
 * Rows deleted per round of the batched search-log purge. See
 * `SearchService.purgeOlderThan`.
 */
const SEARCH_LOG_PURGE_BATCH_SIZE = 5000;

function emptyPage(query: string): SearchResultPage {
  return {
    query,
    total: 0,
    hits: [],
    products: [],
    categories: [],
    brands: [],
    blog_posts: [],
    pages: [],
  };
}

export const searchService = new SearchService();
