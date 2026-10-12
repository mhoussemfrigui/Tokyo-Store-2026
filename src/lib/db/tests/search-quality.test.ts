import "server-only";

/**
 * DB-backed search QUALITY invariants for the product reader (queries.ts
 * `searchProducts`) + the service chokepoint:
 *
 *   1. « Afficher les produits en rupture » (showOutOfStock = true): the page is
 *      picked by RELEVANCE, then in-stock hits are listed before out-of-stock ones
 *      within it (keyword AND semantic shapes) — so a strong out-of-stock match is
 *      never pushed OFF a full page by weaker in-stock hits (« restent visibles »).
 *      With it off, out-of-stock products are excluded.
 *   2. Semantic recall has a SIMILARITY FLOOR: a neighbour below
 *      `semanticMinSimilarity` is never recalled on its vector alone (so gibberish
 *      stops "finding" products and zero-result analytics stay meaningful).
 *   3. Semantic recall is restricted to the LIVE embedding model: a vector
 *      fingerprinted under another model is excluded, a NULL-hash (text-drifted,
 *      stale-but-same-space) vector stays eligible.
 *   4. The service caps the query length (MAX_SEARCH_QUERY_LENGTH) before any reader.
 *
 * Vectors are hand-built unit vectors (no embedding provider needed). Self-cleaning
 * (`ztest-squal` slugs). Run against the ISOLATED test DB only:
 *   DATABASE_URL=postgresql://tokyo:tokyo_dev_pwd@localhost:5440/tokyo \
 *   BETTER_AUTH_SECRET=test-secret-test-secret-test-secret-123 EMAIL_PROVIDER=console \
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/search-quality.test.ts
 */
import { like, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { searchService } from "@/modules/search";
import { searchProducts } from "@/modules/search/queries";
import {
  MAX_SEARCH_QUERY_LENGTH,
  resolveSearchConfig,
  toQueryConfig,
} from "@/modules/search/parse-config";
import { toVectorLiteral } from "@/modules/search/vector";
import { EMBEDDING_DIM } from "@/lib/ai/embed";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

const TAG = "ztest-squal";
/** Distinctive nonsense token so the keyword branch only matches our rows. */
const TOKEN = "Zzbrevlor";
/** Gibberish query for the vector-only cases: shares no word/trigram with any name. */
const GIBBERISH = "qxjwpfk";
const MODEL = "ztestmodel";
const MODEL_PREFIX = `${MODEL}|`;

async function cleanup() {
  await db.delete(products).where(like(products.slug, `${TAG}%`));
}

async function insertProduct(suffix: string, name: string, inStock: boolean): Promise<string> {
  const [row] = await db
    .insert(products)
    .values({
      slug: `${TAG}-${suffix}`,
      name,
      price_cents: 100000,
      in_stock: inStock,
      is_published: true,
      published_at: sql`now()`,
    } as never)
    .returning({ id: products.id });
  return row.id;
}

/** A 1536-dim vector with `a` on axis 0 and `b` on axis 1 (cosine vs e0 = a/√(a²+b²)). */
function vectorArray(a: number, b: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = a;
  v[1] = b;
  return v;
}

/** {@link vectorArray} as a `::vector` literal for the raw UPDATE. */
function vec(a: number, b: number): string {
  const lit = toVectorLiteral(vectorArray(a, b));
  if (!lit) throw new Error("bad test vector");
  return lit;
}

async function setEmbedding(id: string, literal: string, hash: string | null) {
  await db.execute(
    sql`UPDATE products SET embedding = ${literal}::vector, embedding_input_hash = ${hash} WHERE id = ${id}`,
  );
}

async function main() {
  await cleanup();
  const base = toQueryConfig(resolveSearchConfig({}));

  // ── 1. keyword path: in-stock ranks first even with a LOWER score ──────────────
  console.log("keyword path — out-of-stock ranked after in-stock:");
  // OOS: the name IS the token (max trigram similarity + dense FTS rank).
  const oosStrong = await insertProduct("oos-strong", `${TOKEN} ${TOKEN}`, false);
  // In stock: the token buried in a long name (lower similarity + rank).
  const inWeak = await insertProduct(
    "in-weak",
    `Montre automatique acier chronographe bracelet cuir ${TOKEN}`,
    true,
  );
  const hits = await searchProducts(TOKEN, 10, base);
  const oosHit = hits.find((h) => h.id === oosStrong);
  const inHit = hits.find((h) => h.id === inWeak);
  check("both rows found", !!oosHit && !!inHit);
  check(
    "precondition: the OOS row scores HIGHER (so a score-first sort would put it on top)",
    !!oosHit && !!inHit && oosHit.score > inHit.score,
  );
  check(
    "showOutOfStock=true: in-stock hit ranks BEFORE the higher-scoring OOS hit",
    hits.findIndex((h) => h.id === inWeak) < hits.findIndex((h) => h.id === oosStrong),
  );
  const hitsNoOos = await searchProducts(TOKEN, 10, { ...base, showOutOfStock: false });
  check(
    "showOutOfStock=false: OOS excluded, in-stock kept",
    !hitsNoOos.some((h) => h.id === oosStrong) && hitsNoOos.some((h) => h.id === inWeak),
  );

  // Limit-bound: the in-stock partition happens AFTER the relevance LIMIT, so a
  // strong OOS match stays on a full page instead of being displaced by weaker
  // in-stock hits.
  console.log("keyword path — a full page keeps the strong OOS match:");
  // In stock, the token buried in an even longer name (lowest trigram similarity).
  const inWeaker = await insertProduct(
    "in-weaker",
    `Montre automatique acier chronographe bracelet cuir saphir lunette tournante etanche ${TOKEN}`,
    true,
  );
  const all3 = await searchProducts(TOKEN, 10, base);
  const s = (id: string) => all3.find((h) => h.id === id)?.score ?? Number.NaN;
  check(
    "precondition: relevance order is oos-strong > in-weak > in-weaker",
    s(oosStrong) > s(inWeak) && s(inWeak) > s(inWeaker),
  );
  const page2 = await searchProducts(TOKEN, 2, base);
  check(
    "limit 2 ⇒ [in-weak, oos-strong]: OOS kept (relevance top 2), listed after in-stock",
    page2.length === 2 && page2[0]?.id === inWeak && page2[1]?.id === oosStrong,
  );

  // ── 2/3. semantic path: similarity floor + live-model filter ──────────────────
  console.log("semantic path — similarity floor + model fingerprint:");
  const near = await insertProduct("near", "Alpha plongee", true); // sim 1, current model
  const nearish = await insertProduct("nearish", "Beta plongee", true); // sim ≈0.8, current model
  const far = await insertProduct("far", "Gamma bracelet", true); // sim 0, current model
  const otherModel = await insertProduct("other-model", "Delta plongee", true); // sim 1, OTHER model
  const drifted = await insertProduct("drifted", "Epsilon plongee", true); // sim 1, NULL hash
  const oosNear = await insertProduct("oos-near", "Zeta plongee", false); // sim 1, OOS
  await setEmbedding(near, vec(1, 0), `${MODEL}|v2|near`);
  await setEmbedding(nearish, vec(0.8, 0.6), `${MODEL}|v2|nearish`);
  await setEmbedding(far, vec(0, 1), `${MODEL}|v2|far`);
  await setEmbedding(otherModel, vec(1, 0), "zothermodel|v2|other");
  await setEmbedding(drifted, vec(1, 0), null);
  await setEmbedding(oosNear, vec(1, 0), `${MODEL}|v2|oos`);

  // The query vector is e0 — the same axis `near` sits on.
  const queryVec = vectorArray(1, 0);
  const sem = { ...base, semanticEnabled: true, semanticMinSimilarity: 0.35 };
  const semHits = await searchProducts(GIBBERISH, 20, sem, db, [], queryVec, MODEL_PREFIX);
  const ids = new Set(semHits.map((h) => h.id));
  check("vector-only neighbour above the floor is recalled", ids.has(near) && ids.has(nearish));
  check("neighbour BELOW the floor (cosine 0) is NOT recalled", !ids.has(far));
  check("vector fingerprinted under ANOTHER model is excluded", !ids.has(otherModel));
  check("NULL-hash (text-drifted, same space) vector stays eligible", ids.has(drifted));
  check(
    "semantic shape also ranks in-stock first (sim≈0.8 in-stock before sim=1 OOS)",
    ids.has(oosNear) &&
      semHits.findIndex((h) => h.id === nearish) < semHits.findIndex((h) => h.id === oosNear),
  );
  // Full page (3): the sim=1 rows (near, drifted, oos-near) out-rank nearish (≈0.8),
  // so the exact-but-OOS neighbour must stay on the page — nearish must not bump it.
  const sem3 = await searchProducts(GIBBERISH, 3, sem, db, [], queryVec, MODEL_PREFIX);
  check(
    "semantic limit 3 ⇒ the sim=1 OOS neighbour stays on the page (weaker in-stock does not displace it)",
    sem3.some((h) => h.id === oosNear) && !sem3.some((h) => h.id === nearish),
  );
  check(
    "semantic limit 3 ⇒ the OOS neighbour is listed last (after the in-stock ones)",
    sem3.length === 3 && sem3[2]?.id === oosNear,
  );

  const floorOff = await searchProducts(
    GIBBERISH,
    20,
    { ...sem, semanticMinSimilarity: 0 },
    db,
    [],
    queryVec,
    MODEL_PREFIX,
  );
  check(
    "floor 0 ⇒ the orthogonal neighbour IS recalled (the floor did the filtering)",
    floorOff.some((h) => h.id === far),
  );

  const noModel = await searchProducts(GIBBERISH, 20, sem, db, [], queryVec, null);
  check(
    "no model prefix ⇒ the other-model vector IS recalled (the prefix did the filtering)",
    noModel.some((h) => h.id === otherModel),
  );

  const semOff = await searchProducts(GIBBERISH, 20, base, db, [], queryVec, MODEL_PREFIX);
  const ours = new Set([near, nearish, far, otherModel, drifted, oosNear]);
  check(
    "semantic OFF ⇒ the gibberish query recalls none of the embedded rows",
    !semOff.some((h) => ours.has(h.id)),
  );

  // ── 4. service chokepoint caps the query length ────────────────────────────────
  console.log("service — query length cap:");
  const longPage = await searchService.search(`${TOKEN} ${"x".repeat(5000)}`, {
    skipLog: true,
    kinds: ["product"],
  });
  check(
    `a 5000-char query is capped to ${MAX_SEARCH_QUERY_LENGTH} chars before the readers`,
    longPage.query.length === MAX_SEARCH_QUERY_LENGTH && longPage.query.startsWith(TOKEN),
  );

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .catch(async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* best-effort */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
