import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import {
  generateEmbeddings,
  resolveEmbeddingModel,
  resolveEmbeddingTarget,
  MAX_EMBEDDING_BATCH,
} from "@/lib/ai/embed";
import { buildEmbeddingInput, hashEmbeddingInput, embeddingHashPrefix, MAX_DESC_CHARS } from "./embed-input";
import { htmlToText } from "@/lib/ai/parse";

/** Escape LIKE metacharacters so a model id containing `_`/`%`/`\` matches as a
 *  literal prefix (parity with the `starts_with` semantics the live reader uses). */
function escapeLikePrefix(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The model that will actually embed (provider-aware), falling back to the generic
 *  default for coverage display when no provider is configured. Used everywhere the
 *  pipeline needs the model so the FINGERPRINT model always matches the EMBED model. */
async function currentEmbeddingModel(): Promise<string> {
  const target = await resolveEmbeddingTarget();
  return target?.model ?? (await resolveEmbeddingModel());
}

/**
 * Product-embedding pipeline — the server-side core shared by the live save
 * subscriber (`reembed-product`) and the admin backfill. Reads a product's text via
 * raw SQL (name + brand + categories + caractéristiques/attributes + short + full
 * description), builds the canonical embedding input, and re-embeds ONLY when the
 * input's fingerprint changed (hash-gated), then writes the vector to the DB-only
 * `products.embedding` column (raw SQL — Drizzle has no handle on the pgvector type,
 * exactly like `search_vector`).
 *
 * Every entry point is best-effort: a missing provider or a provider error records
 * a failure and moves on; it never throws into the caller (a save must not fail
 * because embeddings are down, and the backfill must survive a flaky batch).
 */

type ProductTextRow = {
  id: string;
  name: string;
  short_desc: string | null;
  description: string | null;
  brand_name: string | null;
  category_names: string[] | null;
  /** « Name : Value » attribute pairs (caractéristiques) — assignments + scalars. */
  attribute_pairs: string[] | null;
  embedding_input_hash: string | null;
};

/**
 * The SELECT columns + brand join shared by both readers (readProductTextRows +
 * selectBackfillCandidates) so the embedding INPUT text is sourced identically on the
 * live-save path and the backfill path. Includes the caractéristiques (attributes)
 * aggregation — assignments (multiselect/select) UNION scalars (free text) — each
 * "Name : Value", sorted for a stable input (so the fingerprint is deterministic).
 */
const PRODUCT_TEXT_COLUMNS = sql`
  p.id, p.name, p.short_desc, p.description, p.embedding_input_hash,
  b.name AS brand_name,
  (SELECT array_agg(c.name ORDER BY pc.is_primary DESC, c.name)
     FROM product_categories pc
     JOIN categories c ON c.id = pc.category_id AND c.deleted_at IS NULL
    WHERE pc.product_id = p.id) AS category_names,
  (SELECT array_agg(txt ORDER BY txt) FROM (
     SELECT DISTINCT a.name || ' : ' || v.label AS txt
       FROM product_attribute_assignments pa
       JOIN product_attribute_values v ON v.id = pa.attribute_value_id
       JOIN product_attributes a ON a.id = v.attribute_id AND a.is_active = true
      WHERE pa.product_id = p.id
     UNION
     SELECT DISTINCT a.name || ' : ' || s.text_value AS txt
       FROM product_attribute_scalars s
       JOIN product_attributes a ON a.id = s.attribute_id AND a.is_active = true
      WHERE s.product_id = p.id AND s.text_value IS NOT NULL AND s.text_value <> ''
   ) u) AS attribute_pairs`;

const PRODUCT_TEXT_FROM = sql`
  FROM products p
  LEFT JOIN product_brands pb ON pb.product_id = p.id
  LEFT JOIN brands b ON b.id = pb.brand_id AND b.deleted_at IS NULL`;

export type EmbedOutcome = {
  /** Rows considered. */
  processed: number;
  /** Rows whose vector was (re)written. */
  embedded: number;
  /** Rows already on the current fingerprint (no API call). */
  skipped: number;
  /** Rows that failed to embed (provider/API error). */
  failed: number;
  /** Distinct provider/API error messages seen (bounded). */
  errors: string[];
};

const emptyOutcome = (): EmbedOutcome => ({ processed: 0, embedded: 0, skipped: 0, failed: 0, errors: [] });

/** Embedding-input source columns for a set of product ids (raw SQL — DB-only vector cols).
 *  Exported so tests can assert the caractéristiques/attribute aggregation content. */
export async function readProductTextRows(ids: string[]): Promise<ProductTextRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.execute<ProductTextRow>(sql`
    SELECT ${PRODUCT_TEXT_COLUMNS}
    ${PRODUCT_TEXT_FROM}
    WHERE p.deleted_at IS NULL
      AND p.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `);
  return rows.rows;
}

/** Bulk-write vectors + fingerprints in ONE statement (VALUES join). Exported so the
 *  write path (a raw pgvector bulk UPDATE that the API-key-gated backfill would otherwise
 *  be the only exerciser of) is directly testable. `vecLiteral` is a pgvector text literal
 *  (`[0.1,…]`). */
export async function writeProductEmbeddings(
  items: { id: string; vecLiteral: string; hash: string }[],
): Promise<void> {
  if (items.length === 0) return;
  const values = sql.join(
    items.map((it) => sql`(${it.id}::uuid, ${it.vecLiteral}::text, ${it.hash}::text)`),
    sql`, `,
  );
  await db.execute(sql`
    UPDATE products AS p
    SET embedding = v.emb::vector, embedding_input_hash = v.h
    FROM (VALUES ${values}) AS v(id, emb, h)
    WHERE p.id = v.id
  `);
}

/**
 * Mark products as NEEDING (re)embedding by NULLing their fingerprint — the single
 * healing primitive. A row with a NULL `embedding_input_hash` re-enters both the
 * backfill's needing-set AND the coverage « needing » count, so text drift the live
 * path could not fulfil (semantic off, a provider error, or a category/brand rename)
 * is recoverable by the next « Vectoriser » run instead of being stranded as
 * silently-stale-but-counted-current. The stale vector is LEFT in place so search
 * keeps working (slightly stale) until it's re-embedded. Best-effort (never throws).
 */
export async function markProductsNeedEmbedding(ids: string[]): Promise<void> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return;
  await db
    .execute(sql`
      UPDATE products SET embedding_input_hash = NULL
      WHERE id IN (${sql.join(unique.map((id) => sql`${id}`), sql`, `)})
        AND embedding_input_hash IS NOT NULL
    `)
    .catch((err) => console.error("[search] markProductsNeedEmbedding failed", err));
}

/** Mark every product linked to a brand as needing re-embedding (a brand RENAME changes
 *  their embedding input). One bulk UPDATE — bounded, no API cost. Best-effort. */
export async function markBrandProductsNeedEmbedding(brandId: string): Promise<void> {
  await db
    .execute(sql`
      UPDATE products SET embedding_input_hash = NULL
      WHERE embedding_input_hash IS NOT NULL
        AND id IN (SELECT product_id FROM product_brands WHERE brand_id = ${brandId})
    `)
    .catch((err) => console.error("[search] markBrandProductsNeedEmbedding failed", err));
}

/** Mark every product linked to a category as needing re-embedding (a category RENAME
 *  changes their embedding input). One bulk UPDATE — bounded, no API cost. Best-effort. */
export async function markCategoryProductsNeedEmbedding(categoryId: string): Promise<void> {
  await db
    .execute(sql`
      UPDATE products SET embedding_input_hash = NULL
      WHERE embedding_input_hash IS NOT NULL
        AND id IN (SELECT product_id FROM product_categories WHERE category_id = ${categoryId})
    `)
    .catch((err) => console.error("[search] markCategoryProductsNeedEmbedding failed", err));
}

/** Mark every product carrying an attribute (via any of its values OR a scalar) as needing
 *  re-embedding — an attribute rename / value-label rename / deactivation / deletion changes
 *  the « Caractéristiques » segment of the embedding input. One bulk UPDATE — bounded, no API
 *  cost. Best-effort. */
export async function markAttributeProductsNeedEmbedding(attributeId: string): Promise<void> {
  await db
    .execute(sql`
      UPDATE products SET embedding_input_hash = NULL
      WHERE embedding_input_hash IS NOT NULL
        AND (id IN (SELECT pa.product_id
                      FROM product_attribute_assignments pa
                      JOIN product_attribute_values v ON v.id = pa.attribute_value_id
                     WHERE v.attribute_id = ${attributeId})
          OR id IN (SELECT product_id FROM product_attribute_scalars WHERE attribute_id = ${attributeId}))
    `)
    .catch((err) => console.error("[search] markAttributeProductsNeedEmbedding failed", err));
}

/**
 * Embed a set of already-loaded rows against `model`, skipping rows whose stored
 * fingerprint already matches. Batches the API calls at {@link MAX_EMBEDDING_BATCH};
 * a failed batch is recorded (rows counted failed) and the rest continue.
 */
async function embedRows(
  rows: ProductTextRow[],
  model: string,
  actorUserId: string | null,
): Promise<EmbedOutcome> {
  const out = emptyOutcome();
  const pending: { id: string; input: string; hash: string }[] = [];
  for (const r of rows) {
    out.processed += 1;
    const input = buildEmbeddingInput({
      name: r.name,
      // Strip HTML from BOTH descriptions (short_desc + description can hold markup) so no
      // tags enter the vector AND the desc!==shortDesc dedup compares plain text to plain text.
      shortDesc: htmlToText(r.short_desc, MAX_DESC_CHARS),
      description: htmlToText(r.description, MAX_DESC_CHARS),
      brandName: r.brand_name,
      categoryNames: r.category_names ?? [],
      attributes: r.attribute_pairs ?? [],
    });
    // A product with no embeddable text (blank name after cleaning) can't be embedded —
    // sending it would abort its whole batch (the API rejects an empty input). Skip it.
    if (!input) {
      out.skipped += 1;
      continue;
    }
    const hash = hashEmbeddingInput(input, model);
    if (r.embedding_input_hash === hash) {
      out.skipped += 1;
      continue;
    }
    pending.push({ id: r.id, input, hash });
  }
  if (pending.length === 0) return out;

  for (let i = 0; i < pending.length; i += MAX_EMBEDDING_BATCH) {
    const chunk = pending.slice(i, i + MAX_EMBEDDING_BATCH);
    const res = await generateEmbeddings(chunk.map((c) => c.input), { actorUserId });
    if (!res.ok) {
      out.failed += chunk.length;
      if (!out.errors.includes(res.error)) out.errors.push(res.error);
      // Leave these rows in the NEEDING set — a re-embed that never wrote must not keep a
      // stale/absent vector while its (possibly still-current-prefix) hash hides it from
      // the next backfill. NULLing the fingerprint guarantees they're re-selected.
      await markProductsNeedEmbedding(chunk.map((c) => c.id));
      continue;
    }
    await writeProductEmbeddings(
      chunk.map((c, j) => ({ id: c.id, vecLiteral: `[${res.embeddings[j].join(",")}]`, hash: c.hash })),
    ).then(
      () => {
        out.embedded += chunk.length;
      },
      async (err) => {
        out.failed += chunk.length;
        const msg = err instanceof Error ? err.message : "Échec de l'écriture des embeddings";
        if (!out.errors.includes(msg)) out.errors.push(msg);
        await markProductsNeedEmbedding(chunk.map((c) => c.id));
      },
    );
  }
  return out;
}

/**
 * (Re)embed specific products — the live path from the product-save subscriber. No-op
 * for ids that are deleted (filtered out by the read) or already on the current
 * fingerprint. Best-effort: never throws.
 */
export async function embedProductsByIds(
  ids: string[],
  opts: { actorUserId?: string | null } = {},
): Promise<EmbedOutcome> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (unique.length === 0) return emptyOutcome();
  try {
    const model = await currentEmbeddingModel();
    const rows = await readProductTextRows(unique);
    return await embedRows(rows, model, opts.actorUserId ?? null);
  } catch (err) {
    const out = emptyOutcome();
    out.failed = unique.length;
    out.errors.push(err instanceof Error ? err.message : "Échec d'embedding");
    return out;
  }
}

export type EmbeddingCoverage = {
  /** Published, non-deleted products (the embeddable universe). */
  totalPublished: number;
  /** …with any embedding vector. */
  embedded: number;
  /** …with an embedding fingerprinted on the CURRENT model (up to date). */
  current: number;
  /** totalPublished − current (what the backfill still has to do). */
  needing: number;
  /** The embedding model the coverage was measured against. */
  model: string;
};

/** Coverage snapshot for the admin « Sémantique » panel. */
export async function getEmbeddingCoverage(): Promise<EmbeddingCoverage> {
  const model = await currentEmbeddingModel();
  const like = `${escapeLikePrefix(embeddingHashPrefix(model))}%`;
  const rows = await db.execute<{ total_published: number; embedded: number; current: number }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE p.is_published)::int AS total_published,
      COUNT(*) FILTER (WHERE p.is_published AND p.embedding IS NOT NULL)::int AS embedded,
      COUNT(*) FILTER (WHERE p.is_published AND p.embedding IS NOT NULL AND p.embedding_input_hash LIKE ${like})::int AS current
    FROM products p
    WHERE p.deleted_at IS NULL
  `);
  const r = rows.rows[0];
  const totalPublished = Number(r?.total_published ?? 0);
  const current = Number(r?.current ?? 0);
  return {
    totalPublished,
    embedded: Number(r?.embedded ?? 0),
    current,
    needing: Math.max(0, totalPublished - current),
    model,
  };
}

/**
 * Cheap per-batch "still pending" count — the EXACT predicate
 * {@link selectBackfillCandidates} recalls against, as ONE `COUNT(*)` rather than the
 * 3-FILTER {@link getEmbeddingCoverage} aggregate (which also computes totalPublished /
 * embedded that the backfill loop never reads). Because it mirrors the candidate WHERE
 * exactly, `done = (pending === 0)` stays correct even during a MODEL CHANGE (stale-
 * fingerprint rows still count). In the steady state (no stale rows) the `embedding IS NULL`
 * term rides the 0115 partial index; a model change adds the `NOT LIKE` scan — still a
 * single number per batch.
 */
async function countPendingEmbeddings(model: string): Promise<number> {
  const like = `${escapeLikePrefix(embeddingHashPrefix(model))}%`;
  const rows = await db.execute<{ pending: number }>(sql`
    SELECT COUNT(*)::int AS pending
    FROM products p
    WHERE p.deleted_at IS NULL
      AND p.is_published = true
      AND (p.embedding IS NULL
           OR p.embedding_input_hash IS NULL
           OR p.embedding_input_hash NOT LIKE ${like})
  `);
  return Number(rows.rows[0]?.pending ?? 0);
}

/** Products still lacking a current-model embedding, NULLs first. */
async function selectBackfillCandidates(limit: number, model: string): Promise<ProductTextRow[]> {
  const like = `${escapeLikePrefix(embeddingHashPrefix(model))}%`;
  const rows = await db.execute<ProductTextRow>(sql`
    SELECT ${PRODUCT_TEXT_COLUMNS}
    ${PRODUCT_TEXT_FROM}
    WHERE p.deleted_at IS NULL
      AND p.is_published = true
      AND (p.embedding IS NULL
           OR p.embedding_input_hash IS NULL
           OR p.embedding_input_hash NOT LIKE ${like})
    ORDER BY (p.embedding IS NULL) DESC, p.updated_at DESC
    LIMIT ${limit}
  `);
  return rows.rows;
}

export type BackfillBatchResult = EmbedOutcome & {
  /** Products still needing a current-model embedding AFTER this batch. */
  remaining: number;
  /** True when nothing is left — the client loop stops. */
  done: boolean;
};

/**
 * Embed ONE backfill batch: pick up to `limit` published products lacking a current-model
 * embedding and embed them, then report how many still remain. The admin panel calls this
 * repeatedly until `done`. Naturally resumable + idempotent — progress is the DB itself
 * (already-embedded products are simply not selected next time), so closing the page just
 * pauses the run.
 */
export async function embedNextBackfillBatch(
  limit = 100,
  opts: { actorUserId?: string | null } = {},
): Promise<BackfillBatchResult> {
  const lim = Math.max(1, Math.min(limit, 200));
  const model = await currentEmbeddingModel();
  const rows = await selectBackfillCandidates(lim, model);
  const outcome = rows.length > 0 ? await embedRows(rows, model, opts.actorUserId ?? null) : emptyOutcome();
  // Exact remaining via a single COUNT (not the full coverage aggregate) — see
  // countPendingEmbeddings. `done` is correct even mid model-change.
  const remaining = await countPendingEmbeddings(model);
  return { ...outcome, remaining, done: remaining === 0 };
}

/**
 * SERVER-side full backfill loop — embeds every pending product by chaining
 * {@link embedNextBackfillBatch} until nothing remains. Used to AUTO-vectorise after a
 * bulk import (the client-driven admin panel loop is the interactive equivalent). Never
 * throws. A STUCK-GUARD stops the loop when a batch embeds nothing AND the backlog doesn't
 * shrink (no provider / persistent provider error) so a misconfigured store can't spin
 * forever; a hard `maxBatches` ceiling bounds it regardless. Best-effort + idempotent
 * (already-embedded products aren't reselected).
 */
export async function backfillPendingEmbeddings(
  opts: { actorUserId?: string | null; maxBatches?: number } = {},
): Promise<{ embedded: number; failed: number; batches: number; done: boolean }> {
  const maxBatches = Math.max(1, opts.maxBatches ?? 2000);
  let embedded = 0;
  let failed = 0;
  let batches = 0;
  let done = false;
  let prevRemaining = Number.POSITIVE_INFINITY;
  for (let i = 0; i < maxBatches; i++) {
    const res = await embedNextBackfillBatch(100, { actorUserId: opts.actorUserId ?? null }).catch(() => null);
    if (!res) break; // hard error — bail (best-effort)
    batches += 1;
    embedded += res.embedded;
    failed += res.failed;
    if (res.done) {
      done = true;
      break;
    }
    // No progress (nothing embedded + backlog not shrinking) ⇒ no provider / stuck ⇒ stop.
    if (res.embedded === 0 && res.remaining >= prevRemaining) break;
    prevRemaining = res.remaining;
  }
  return { embedded, failed, batches, done };
}
