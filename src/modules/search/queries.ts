import "server-only";

import { sql } from "drizzle-orm";

import { db, type DbOrTx } from "@/lib/db/client";
import {
  SEARCH_DEFAULTS,
  needsTrigramTx,
  toQueryConfig,
  type SearchQueryConfig,
} from "./parse-config";
import type { SearchKind } from "./types";
import { toVectorLiteral } from "./vector";

// Re-export so existing importers of "./queries" keep resolving it (the guard now
// lives in the pure ./vector module so it can be unit-tested under test:pure).
export { toVectorLiteral };

/**
 * Low-level FTS readers.
 *
 * Drizzle's typed query DSL doesn't understand tsquery / @@ / similarity()
 * cleanly, so the FTS hot path is hand-rolled SQL wrapped in `sql\`\`` tags
 * (which still parameterise correctly — no string interpolation).
 *
 * Every reader follows the same hybrid pattern:
 *
 *   rank   = ts_rank_cd(search_vector, websearch_to_tsquery('fr_unaccent', $q))
 *   sim    = similarity(name|title, $raw)            -- pg_trgm similarity()
 *   score  = rank * α + sim * β                      -- α/β from search config
 *
 * `websearch_to_tsquery` is the Google-style parser — handles quoted
 * phrases ("apex velocity"), negation (-thing) and OR (foo OR bar)
 * without us writing a tokeniser. `fr_unaccent` is the custom text-search
 * config created in the baseline migration (french stem + unaccent
 * dictionary).
 *
 * The trigram branch (the pg_trgm `%` operator) is what gives us typo recovery:
 * "Apex Veloctiy" → "Apex Velocity" lands on the trigram branch when the
 * tsquery branch returns nothing. We use `name % $raw` (NOT a bare
 * `similarity() >= x` call) because ONLY the operator rides the `gin_trgm_ops`
 * indexes — so the `(search_vector @@ q OR name % q)` disjunction can BitmapOr
 * the FTS-GIN with the trigram-GIN instead of seq-scanning. We always run both
 * branches and order by the combined score so exact matches still win.
 *
 * The weights (α/β) are admin-tunable via the search config (interpolated as
 * bound numeric params). The trigram threshold is steered through the
 * `pg_trgm.similarity_threshold` GUC (see {@link runSearchReaders}) so the
 * `%` operator keeps its index while honouring the admin knob, WITHOUT opening a
 * transaction per reader. Defaults reproduce the historical α=2 / β=1 /
 * threshold=0.3 behaviour.
 */

// Re-export the pure types so existing importers of "./queries" are unchanged.
export type {
  SearchHitKind,
  SearchHit,
  ProductSearchHit,
} from "./types";
import type { SearchHit, ProductSearchHit } from "./types";

/** Cap to keep tsquery / pg_trgm bounded on adversarial input. */
const MAX_LIMIT = 50;

function clampLimit(n: number | undefined): number {
  return Math.max(1, Math.min(n ?? 20, MAX_LIMIT));
}

/**
 * Scoring config for a single reader. Defaults reproduce the legacy hard-coded
 * behaviour so callers that don't pass a config see no change. Derived from
 * `SEARCH_DEFAULTS` via the same projection the service uses (one source of
 * truth — no hand-maintained duplicate).
 */
const DEFAULT_QUERY_CONFIG: SearchQueryConfig = toQueryConfig(SEARCH_DEFAULTS);

/**
 * How many nearest EMBEDDED neighbours the semantic KNN CTE recalls into the
 * candidate set. Kept at pgvector's default `hnsw.ef_search` (40) so the KNN can
 * actually return this many — a LIMIT above ef_search silently yields fewer rows.
 * The final query LIMIT still trims to the configured page size.
 *
 * TUNING NOTE: this equals ef_search, so the tail of the 40 candidates is the
 * least-accurate part of the graph search. We do NOT `SET hnsw.ef_search` per query
 * on purpose — the default-threshold path runs the readers in PARALLEL on the pool,
 * so a session-level SET would leak across pooled connections. If the server's
 * `hnsw.ef_search` is ever lowered BELOW 40 this CTE returns fewer than 40
 * neighbours; keep the server default at >= 40 (or, to raise recall, bump ef_search
 * server-side / in a dedicated per-query transaction and lift this constant to match).
 */
const SEMANTIC_RECALL_LIMIT = 40;

/**
 * The FROM-clause tsquery source (`… AS q`) every reader matches against. With NO
 * alias expansions it is the byte-for-byte `websearch_to_tsquery('fr_unaccent', $raw)
 * AS q` — so a store with no aliases emits the exact legacy query. With expansions it
 * OR-s (`||`) one `websearch_to_tsquery(expansion)` per variant into `q`, widening FTS
 * recall only (the raw query still drives the trigram `%` + name scoring). The variant
 * count is capped upstream (MAX_QUERY_EXPANSIONS) so the tsquery stays bounded.
 */
function qSource(raw: string, expansions: string[]) {
  if (expansions.length === 0) return sql`websearch_to_tsquery('fr_unaccent', ${raw}) AS q`;
  const parts = [sql`websearch_to_tsquery('fr_unaccent', ${raw})`];
  for (const e of expansions) parts.push(sql`websearch_to_tsquery('fr_unaccent', ${e})`);
  return sql`(SELECT (${sql.join(parts, sql` || `)}) AS q) t`;
}

/**
 * Run the per-kind readers for ONE search, applying the trigram threshold to the
 * index-accelerated `%` operator WITHOUT amplifying connection use:
 *
 *   • threshold == 0.3 (default): run the thunks in PARALLEL on the pool — each
 *     acquires/releases its own connection for one SELECT, and `%` uses PG's
 *     session-default 0.3. Byte-for-byte the historical footprint.
 *   • threshold != 0.3: open ONE transaction, set the GUC TRANSACTION-LOCALLY
 *     once (`set_config(…, true)` — can't leak to the pooled connection), then
 *     run the thunks SEQUENTIALLY on that single pinned connection. Each runs
 *     inside a SAVEPOINT so one kind's failure rolls back just that kind, not the
 *     whole batch. This caps a tuned search at ONE connection (was up to 6).
 *
 * Either path degrades a failing kind to `[]` (never throws), preserving the
 * "a broken kind never 500s the search box" contract.
 */
export async function runSearchReaders(
  threshold: number,
  thunks: Partial<Record<SearchKind, (exec: DbOrTx) => Promise<SearchHit[]>>>,
): Promise<Partial<Record<SearchKind, SearchHit[]>>> {
  const keys = Object.keys(thunks) as SearchKind[];
  const out: Partial<Record<SearchKind, SearchHit[]>> = {};

  if (!needsTrigramTx(threshold)) {
    const settled = await Promise.allSettled(keys.map((k) => thunks[k]!(db)));
    keys.forEach((k, i) => {
      const r = settled[i];
      if (r.status === "fulfilled") {
        out[k] = r.value;
      } else {
        console.error("[search] kind failed", { kind: k, err: r.reason });
        out[k] = [];
      }
    });
    return out;
  }

  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('pg_trgm.similarity_threshold', ${String(threshold)}, true)`,
      );
      for (const k of keys) {
        try {
          // Nested transaction = SAVEPOINT: a failing kind rolls back to here
          // instead of aborting the shared transaction.
          out[k] = await tx.transaction((sp) => thunks[k]!(sp));
        } catch (err) {
          console.error("[search] kind failed (tuned threshold)", { kind: k, err });
          out[k] = [];
        }
      }
    });
  } catch (err) {
    // BEGIN / set_config itself failed — degrade the whole batch, never throw.
    console.error("[search] tuned-threshold transaction failed", err);
    for (const k of keys) if (!(k in out)) out[k] = [];
  }
  return out;
}

/**
 * Search published products. Returns the lightweight row shape the API
 * layer enriches with image URLs. `embeddingModelPrefix` ("<model>|", from the
 * service's resolved embedding target) restricts vector recall to rows embedded
 * with that model; null = no model filter (callers without a query vector).
 */
export async function searchProducts(
  q: string,
  limit = 20,
  cfg: SearchQueryConfig = DEFAULT_QUERY_CONFIG,
  exec: DbOrTx = db,
  expansions: string[] = [],
  queryEmbedding: number[] = [],
  embeddingModelPrefix: string | null = null,
): Promise<ProductSearchHit[]> {
  const lim = clampLimit(limit);
  // When out-of-stock products are excluded, add a hard predicate; otherwise
  // keep them and deprioritize them (SQL tiebreak + the in-page partition below).
  const stockFilter = cfg.showOutOfStock ? sql`` : sql` AND p.in_stock = true`;
  // The top-N page is picked by RELEVANCE (`score DESC`) — in_stock is only a
  // tiebreak here, never a leading key, so an exact out-of-stock match is never
  // pushed OFF the page by weaker in-stock hits (« restent visibles »). The
  // « classés après les produits en stock » promise is applied AFTER the LIMIT, by
  // a stable partition of that page (see the return). When OOS products are
  // excluded the tiebreak is redundant.
  const stockOrder = cfg.showOutOfStock ? sql`, p.in_stock DESC` : sql``;

  // The cover-image lookup — identical in both the keyword-only and semantic paths.
  const imageSubquery = sql`(SELECT pm.media_id FROM product_media pm
             JOIN media m ON m.id = pm.media_id AND m.deleted_at IS NULL
             WHERE pm.product_id = p.id
             ORDER BY pm.is_primary DESC, pm.display_order ASC, pm.id ASC
             LIMIT 1)`;

  // ── Semantic (vector) recall ───────────────────────────────────────────────
  // vecLiteral is non-null ONLY when semantic is on AND a usable query vector
  // resolved. When it is null we emit the legacy FTS+trigram query (the `else`
  // branch below — same recall + ORDER BY, it only also selects `p.in_stock` for
  // the in-page partition), so a store with semantic off / no provider / no query
  // vector is completely unaffected.
  //
  // When it IS non-null we take a DIFFERENT shape on purpose. The old design folded
  // ` OR vec.id IS NOT NULL` into the recall WHERE, but that predicate sits on the
  // nullable side of the LEFT JOIN inside an OR — Postgres then CANNOT BitmapOr the
  // FTS-GIN with the trigram-GIN (every OR branch must be an indexable predicate on
  // `products`), so it seq-scans the whole table in exactly the config the feature
  // enables. Instead we recall the candidate id set as a UNION of two independently
  // indexable branches — the keyword branch keeps its BitmapOr, the vector branch is
  // ≤40 HNSW-driven PK ids — then JOIN products to that small set and LEFT JOIN vec
  // only to blend in the cosine similarity. No products seq scan (verified by EXPLAIN).
  //
  // Two guards keep the vector branch honest:
  //   • SIMILARITY FLOOR — a neighbour enters the candidate set on its vector alone
  //     only when `sim >= semanticMinSimilarity`. The KNN always returns its nearest
  //     40, even for gibberish, so without the floor every query "found" products
  //     and the zero-result analytics (→ alias workflow) went permanently empty. The
  //     floor sits on the UNION branch, NOT in the vec CTE, so the HNSW-driven
  //     ORDER BY/LIMIT scan is unchanged and keyword hits still blend in their sim.
  //   • MODEL FINGERPRINT — when the caller knows the live embedding model
  //     (`embeddingModelPrefix` = "<model>|"), vectors fingerprinted under ANOTHER
  //     model are excluded: after an `ai.embedding_model` switch the query is embedded
  //     in the new space while stored vectors stay in the old one until « Vectoriser »,
  //     and a cross-space cosine is noise. NULL-hash rows (text drift marked by
  //     markProductsNeedEmbedding — the stale vector is kept ON PURPOSE so search keeps
  //     working) stay eligible. Only the model part of the fingerprint is matched, so
  //     an EMBEDDING_INPUT_VERSION bump (same vector space) doesn't blank recall.
  const vecLiteral = cfg.semanticEnabled ? toVectorLiteral(queryEmbedding) : null;
  const modelFilter = embeddingModelPrefix
    ? sql` AND (embedding_input_hash IS NULL OR starts_with(embedding_input_hash, ${embeddingModelPrefix}))`
    : sql``;

  const statement = !vecLiteral
    ? sql`
    SELECT p.id, p.slug, p.name, p.short_desc, p.price_cents, p.old_price_cents, p.in_stock,
           (ts_rank_cd(p.search_vector, q) * ${cfg.weightName}
            + COALESCE(similarity(p.name, ${q}), 0) * ${cfg.weightDesc}) AS score,
           ${imageSubquery} AS image_media_id
    FROM products p,
         ${qSource(q, expansions)}
    WHERE p.deleted_at IS NULL
      AND p.is_published = true
      AND (p.search_vector @@ q OR p.name % ${q})${stockFilter}
    ORDER BY score DESC${stockOrder}, p.name ASC
    LIMIT ${lim};
  `
    : sql`
    WITH vec AS (
      SELECT id, (1 - (embedding <=> ${vecLiteral}::vector)) AS sim
      FROM products
      WHERE embedding IS NOT NULL AND deleted_at IS NULL AND is_published = true${modelFilter}
      ORDER BY embedding <=> ${vecLiteral}::vector
      LIMIT ${SEMANTIC_RECALL_LIMIT}
    ),
    cand AS (
      SELECT p.id
      FROM products p,
           ${qSource(q, expansions)}
      WHERE p.deleted_at IS NULL
        AND p.is_published = true
        AND (p.search_vector @@ q OR p.name % ${q})
      UNION
      SELECT id FROM vec WHERE sim >= ${cfg.semanticMinSimilarity}::float
    )
    SELECT p.id, p.slug, p.name, p.short_desc, p.price_cents, p.old_price_cents, p.in_stock,
           (ts_rank_cd(p.search_vector, q) * ${cfg.weightName}
            + COALESCE(similarity(p.name, ${q}), 0) * ${cfg.weightDesc}
            + (COALESCE(vec.sim, 0) * ${cfg.weightSemantic}::float)) AS score,
           ${imageSubquery} AS image_media_id
    FROM products p
      JOIN cand ON cand.id = p.id
      LEFT JOIN vec ON vec.id = p.id,
      ${qSource(q, expansions)}
    WHERE p.deleted_at IS NULL
      AND p.is_published = true${stockFilter}
    ORDER BY score DESC${stockOrder}, p.name ASC
    LIMIT ${lim};
  `;

  // `exec` is the pool (default 0.3 → session GUC) or a tx with the threshold
  // GUC already set (see runSearchReaders); `%` rides the gin_trgm_ops index.
  const rows = await exec.execute<{
    id: string;
    slug: string;
    name: string;
    short_desc: string | null;
    price_cents: number;
    old_price_cents: number | null;
    in_stock: boolean;
    image_media_id: string | null;
    score: number;
  }>(statement);

  // « Afficher les produits en rupture »: within the relevance-picked page, list
  // in-stock hits before out-of-stock ones. Array.prototype.sort is stable, so the
  // SQL order (score DESC, name) is kept inside each group. Partitioning AFTER the
  // LIMIT (not as a leading SQL key) is what keeps an exact OOS match visible.
  const ordered = cfg.showOutOfStock
    ? [...rows.rows].sort((a, b) => Number(b.in_stock) - Number(a.in_stock))
    : rows.rows;

  return ordered.map((r) => ({
    kind: "product" as const,
    id: r.id,
    slug: r.slug,
    title: r.name,
    snippet: r.short_desc ?? null,
    // Cover image (primary, else lowest display_order) so product hits show a
    // thumbnail like category/brand hits — the API layer resolves it to a URL.
    image_media_id: r.image_media_id ?? null,
    price_cents: Number(r.price_cents),
    old_price_cents: r.old_price_cents == null ? null : Number(r.old_price_cents),
    in_stock: r.in_stock,
    score: Number(r.score),
  }));
}

export async function searchCategories(
  q: string,
  limit = 10,
  cfg: SearchQueryConfig = DEFAULT_QUERY_CONFIG,
  exec: DbOrTx = db,
  expansions: string[] = [],
): Promise<SearchHit[]> {
  const lim = clampLimit(limit);
  const rows = await exec.execute<{
    id: string;
    slug: string;
    name: string;
    tagline: string | null;
    hero_media_id: string | null;
    score: number;
  }>(sql`
    SELECT id, slug, name, tagline, hero_media_id,
           (ts_rank_cd(search_vector, q) * ${cfg.weightName}
            + COALESCE(similarity(name, ${q}), 0) * ${cfg.weightDesc}) AS score
    FROM categories,
         ${qSource(q, expansions)}
    WHERE deleted_at IS NULL
      AND is_active = true
      AND (search_vector @@ q OR name % ${q})
    ORDER BY score DESC, name ASC
    LIMIT ${lim};
  `);
  return rows.rows.map((r) => ({
    kind: "category" as const,
    id: r.id,
    slug: r.slug,
    title: r.name,
    snippet: r.tagline ?? null,
    image_media_id: r.hero_media_id,
    score: Number(r.score),
  }));
}

export async function searchBrands(
  q: string,
  limit = 10,
  cfg: SearchQueryConfig = DEFAULT_QUERY_CONFIG,
  exec: DbOrTx = db,
  expansions: string[] = [],
): Promise<SearchHit[]> {
  const lim = clampLimit(limit);
  const rows = await exec.execute<{
    id: string;
    slug: string;
    name: string;
    tagline: string | null;
    logo_media_id: string | null;
    score: number;
  }>(sql`
    SELECT id, slug, name, tagline, logo_media_id,
           (ts_rank_cd(search_vector, q) * ${cfg.weightName}
            + COALESCE(similarity(name, ${q}), 0) * ${cfg.weightDesc}) AS score
    FROM brands,
         ${qSource(q, expansions)}
    WHERE deleted_at IS NULL
      AND is_active = true
      AND (search_vector @@ q OR name % ${q})
    ORDER BY score DESC, name ASC
    LIMIT ${lim};
  `);
  return rows.rows.map((r) => ({
    kind: "brand" as const,
    id: r.id,
    slug: r.slug,
    title: r.name,
    snippet: r.tagline ?? null,
    image_media_id: r.logo_media_id,
    score: Number(r.score),
  }));
}

export async function searchBlogPosts(
  q: string,
  limit = 10,
  cfg: SearchQueryConfig = DEFAULT_QUERY_CONFIG,
  exec: DbOrTx = db,
  expansions: string[] = [],
): Promise<SearchHit[]> {
  const lim = clampLimit(limit);
  const rows = await exec.execute<{
    id: string;
    slug: string;
    title: string;
    excerpt: string | null;
    featured_image_media_id: string | null;
    score: number;
  }>(sql`
    SELECT id, slug, title, excerpt, featured_image_media_id,
           (ts_rank_cd(search_vector, q) * ${cfg.weightName}
            + COALESCE(similarity(title, ${q}), 0) * ${cfg.weightDesc}) AS score
    FROM blog_posts,
         ${qSource(q, expansions)}
    WHERE deleted_at IS NULL
      AND is_published = true
      AND (search_vector @@ q OR title % ${q})
    ORDER BY score DESC, title ASC
    LIMIT ${lim};
  `);
  return rows.rows.map((r) => ({
    kind: "blog_post" as const,
    id: r.id,
    slug: r.slug,
    title: r.title,
    snippet: r.excerpt ?? null,
    image_media_id: r.featured_image_media_id,
    score: Number(r.score),
  }));
}

export async function searchPages(
  q: string,
  limit = 5,
  cfg: SearchQueryConfig = DEFAULT_QUERY_CONFIG,
  exec: DbOrTx = db,
  expansions: string[] = [],
): Promise<SearchHit[]> {
  const lim = clampLimit(limit);
  const rows = await exec.execute<{
    id: string;
    slug: string;
    title: string;
    meta_description: string | null;
    og_image_media_id: string | null;
    score: number;
  }>(sql`
    SELECT id, slug, title, meta_description, og_image_media_id,
           (ts_rank_cd(search_vector, q) * ${cfg.weightName}
            + COALESCE(similarity(title, ${q}), 0) * ${cfg.weightDesc}) AS score
    FROM pages,
         ${qSource(q, expansions)}
    WHERE deleted_at IS NULL
      AND is_published = true
      AND (search_vector @@ q OR title % ${q})
    ORDER BY score DESC, title ASC
    LIMIT ${lim};
  `);
  return rows.rows.map((r) => ({
    kind: "page" as const,
    id: r.id,
    slug: r.slug,
    title: r.title,
    snippet: r.meta_description ?? null,
    image_media_id: r.og_image_media_id,
    score: Number(r.score),
  }));
}

// ────────────────────────────────────────────────────── analytics helpers
// These power the /admin/system/search dashboard. Aggregations are cheap
// thanks to the (normalized_query, created_at DESC) btree, the partial
// zero-result index and the BRIN on created_at.

export type SearchAnalyticsRow = {
  normalized_query: string;
  sample_query: string;
  count: number;
  avg_results: number;
  last_seen_at: string;
};

export async function getTopQueries(opts: {
  days?: number;
  limit?: number;
} = {}): Promise<SearchAnalyticsRow[]> {
  const days = Math.max(1, Math.min(opts.days ?? 30, 730));
  const limit = clampLimit(opts.limit ?? 20);
  const rows = await db.execute<{
    normalized_query: string;
    sample_query: string;
    count: number;
    avg_results: number;
    last_seen_at: Date;
  }>(sql`
    SELECT normalized_query,
           (array_agg(query ORDER BY created_at DESC))[1] AS sample_query,
           COUNT(*)::int AS count,
           AVG(result_count)::float AS avg_results,
           MAX(created_at) AS last_seen_at
    FROM search_log
    WHERE created_at >= now() - (${days} || ' days')::interval
    GROUP BY normalized_query
    ORDER BY count DESC, last_seen_at DESC
    LIMIT ${limit};
  `);
  return rows.rows.map((r) => ({
    normalized_query: r.normalized_query,
    sample_query: r.sample_query,
    count: Number(r.count),
    avg_results: Number(r.avg_results) || 0,
    last_seen_at:
      r.last_seen_at instanceof Date
        ? r.last_seen_at.toISOString()
        : new Date(r.last_seen_at).toISOString(),
  }));
}

export async function getZeroResultQueries(opts: {
  days?: number;
  limit?: number;
} = {}): Promise<SearchAnalyticsRow[]> {
  const days = Math.max(1, Math.min(opts.days ?? 30, 730));
  const limit = clampLimit(opts.limit ?? 20);
  const rows = await db.execute<{
    normalized_query: string;
    sample_query: string;
    count: number;
    last_seen_at: Date;
  }>(sql`
    SELECT normalized_query,
           (array_agg(query ORDER BY created_at DESC))[1] AS sample_query,
           COUNT(*)::int AS count,
           MAX(created_at) AS last_seen_at
    FROM search_log
    WHERE result_count = 0
      AND created_at >= now() - (${days} || ' days')::interval
    GROUP BY normalized_query
    ORDER BY count DESC, last_seen_at DESC
    LIMIT ${limit};
  `);
  return rows.rows.map((r) => ({
    normalized_query: r.normalized_query,
    sample_query: r.sample_query,
    count: Number(r.count),
    avg_results: 0,
    last_seen_at:
      r.last_seen_at instanceof Date
        ? r.last_seen_at.toISOString()
        : new Date(r.last_seen_at).toISOString(),
  }));
}

export type SearchOverviewStats = {
  total_searches: number;
  unique_queries: number;
  zero_result_count: number;
  avg_results: number;
};

export async function getOverviewStats(opts: {
  days?: number;
} = {}): Promise<SearchOverviewStats> {
  const days = Math.max(1, Math.min(opts.days ?? 30, 730));
  const rows = await db.execute<{
    total_searches: number;
    unique_queries: number;
    zero_result_count: number;
    avg_results: number;
  }>(sql`
    SELECT COUNT(*)::int                                    AS total_searches,
           COUNT(DISTINCT normalized_query)::int            AS unique_queries,
           COUNT(*) FILTER (WHERE result_count = 0)::int    AS zero_result_count,
           COALESCE(AVG(result_count), 0)::float            AS avg_results
    FROM search_log
    WHERE created_at >= now() - (${days} || ' days')::interval;
  `);
  const r = rows.rows[0];
  return {
    total_searches: Number(r?.total_searches ?? 0),
    unique_queries: Number(r?.unique_queries ?? 0),
    zero_result_count: Number(r?.zero_result_count ?? 0),
    avg_results: Number(r?.avg_results ?? 0),
  };
}
