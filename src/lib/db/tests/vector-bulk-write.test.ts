import "server-only";

/**
 * DB-backed invariants for the two RAW-SQL halves of the product-embedding
 * pipeline (src/modules/search/embedding.service.ts) that no other test drives
 * (the admin backfill is API-key-gated, so without this they only ever ran in
 * production):
 *
 *   1. `readProductTextRows` — the embedding INPUT source: soft-deleted products
 *      are skipped; a soft-deleted brand / category never leaks into the text;
 *      categories list the primary one first; the « caractéristiques » pairs
 *      UNION the value assignments with the free-text scalars as sorted
 *      « Nom : Valeur » strings, excluding inactive attributes and empty scalars.
 *   2. `writeProductEmbeddings` — the ONE-statement pgvector bulk UPDATE (VALUES
 *      join): every item's vector + fingerprint round-trips, rows outside the
 *      batch are untouched, an unknown id is a harmless no-match, a re-write
 *      overwrites, and a wrong-dimension vector is refused by the column type
 *      (never silently stored). A write that silently failed would leave the
 *      product counted as « needing embedding » forever.
 *   3. `markProductsNeedEmbedding` NULLs only the fingerprint (the healing
 *      primitive) and keeps the stale vector searchable.
 *
 * Vectors are hand-built (no embedding provider needed). Self-cleaning
 * (`ztest-vbw` slugs; link rows cascade). Run against the ISOLATED test DB only:
 *   DATABASE_URL=postgresql://tokyo:tokyo_dev_pwd@localhost:5440/tokyo \
 *   BETTER_AUTH_SECRET=test-secret-test-secret-test-secret-123 EMAIL_PROVIDER=console \
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/vector-bulk-write.test.ts
 */
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { EMBEDDING_DIM } from "@/lib/ai/embed";
import { toVectorLiteral } from "@/modules/search/vector";
import {
  markProductsNeedEmbedding,
  readProductTextRows,
  writeProductEmbeddings,
} from "@/modules/search/embedding.service";

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

const TAG = "ztest-vbw";

type Row = Record<string, unknown>;
function rowsOf(res: unknown): Row[] {
  const r = res as { rows?: Row[] };
  return r.rows ?? (res as Row[]);
}

async function cleanup() {
  // Products first: product_brands / product_categories / assignments / scalars
  // all cascade from products (and from brands / categories / attributes).
  await db.execute(sql`delete from products where slug like ${`${TAG}%`}`);
  await db.execute(sql`delete from product_attributes where slug like ${`${TAG}%`}`);
  await db.execute(sql`delete from categories where slug like ${`${TAG}%`}`);
  await db.execute(sql`delete from brands where slug like ${`${TAG}%`}`);
}

async function insertId(query: ReturnType<typeof sql>): Promise<string> {
  const [row] = rowsOf(await db.execute(query));
  return String(row.id);
}

/** `short_desc` / `description` are NOT NULL (DEFAULT '') — "" stands for « no text ». */
const product = (suffix: string, name: string, shortDesc = "", description = "") =>
  insertId(sql`
    insert into products (slug, name, price_cents, short_desc, description)
    values (${`${TAG}-${suffix}`}, ${name}, 100000, ${shortDesc}, ${description})
    returning id`);
const brand = (suffix: string, name: string, deleted = false) =>
  insertId(sql`
    insert into brands (slug, name, deleted_at)
    values (${`${TAG}-${suffix}`}, ${name}, ${deleted ? sql`now()` : null})
    returning id`);
const category = (suffix: string, name: string, deleted = false) =>
  insertId(sql`
    insert into categories (slug, name, deleted_at)
    values (${`${TAG}-${suffix}`}, ${name}, ${deleted ? sql`now()` : null})
    returning id`);
const attribute = (suffix: string, name: string, active = true) =>
  insertId(sql`
    insert into product_attributes (slug, name, is_active)
    values (${`${TAG}-${suffix}`}, ${name}, ${active})
    returning id`);
const attrValue = (attributeId: string, suffix: string, label: string) =>
  insertId(sql`
    insert into product_attribute_values (attribute_id, slug, label)
    values (${attributeId}, ${`${TAG}-${suffix}`}, ${label})
    returning id`);

/** A 1536-dim vector with `a` on axis 0 and `b` on axis 1 — values that float4 stores exactly. */
function vec(a: number, b: number, dim = EMBEDDING_DIM): string {
  const v = new Array<number>(dim).fill(0);
  v[0] = a;
  v[1] = b;
  const lit = toVectorLiteral(v);
  if (!lit) throw new Error("bad test vector");
  return lit;
}

async function stored(id: string): Promise<{ axes: [number, number] | null; dim: number; hash: string | null }> {
  const [r] = rowsOf(
    await db.execute(
      sql`select embedding::text as emb, embedding_input_hash as h from products where id = ${id}`,
    ),
  );
  const emb = r?.emb == null ? null : String(r.emb);
  const parts = emb ? emb.slice(1, -1).split(",").map(Number) : [];
  return {
    axes: emb ? [parts[0], parts[1]] : null,
    dim: parts.length,
    hash: r?.h == null ? null : String(r.h),
  };
}

const same = (a: unknown[] | null | undefined, b: unknown[]) =>
  Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

async function main() {
  await cleanup();

  // ── fixtures ────────────────────────────────────────────────────────────────
  const liveBrand = await brand("brand", "Maison Vbw");
  const deadBrand = await brand("brand-dead", "Marque Supprimée", true);
  const catPrimary = await category("cat-z", "Zeta Montres");
  const catOther = await category("cat-a", "Alpha Montres");
  const catDead = await category("cat-dead", "Catégorie Supprimée", true);
  const boitier = await attribute("attr-boitier", "Boîtier");
  const acier = await attrValue(boitier, "v-acier", "Acier");
  const or = await attrValue(boitier, "v-or", "Or");
  const inactive = await attribute("attr-inactif", "Inactif", false);
  const masque = await attrValue(inactive, "v-masque", "Masqué");
  const mouvement = await attribute("attr-mouvement", "Mouvement");
  const reserve = await attribute("attr-reserve", "Réserve");

  const full = await product("full", "Vbw Chrono", "Court", "<p>Longue description</p>");
  const bare = await product("bare", "Vbw Nu");
  const gone = await product("gone", "Vbw Supprimé", "x", "y");
  const control = await product("control", "Vbw Témoin");
  await db.execute(sql`update products set deleted_at = now() where id = ${gone}`);

  await db.execute(sql`insert into product_brands (product_id, brand_id) values (${full}, ${liveBrand})`);
  await db.execute(sql`insert into product_brands (product_id, brand_id) values (${bare}, ${deadBrand})`);
  await db.execute(sql`
    insert into product_categories (product_id, category_id, is_primary) values
      (${full}, ${catOther}, false),
      (${full}, ${catPrimary}, true),
      (${full}, ${catDead}, false)`);
  await db.execute(sql`
    insert into product_attribute_assignments (product_id, attribute_value_id) values
      (${full}, ${or}), (${full}, ${acier}), (${full}, ${masque})`);
  await db.execute(sql`
    insert into product_attribute_scalars (product_id, attribute_id, text_value) values
      (${full}, ${mouvement}, 'Automatique'),
      (${full}, ${reserve}, ''),
      (${full}, ${inactive}, 'Texte masqué')`);

  // ── 1. readProductTextRows ─────────────────────────────────────────────────
  console.log("readProductTextRows — embedding input aggregation:");
  check("no ids → [] (no query)", (await readProductTextRows([])).length === 0);
  const rows = await readProductTextRows([full, bare, gone]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  check("soft-deleted product is skipped", rows.length === 2 && !byId.has(gone));
  const f = byId.get(full);
  check("name / short / description are the raw columns", f?.name === "Vbw Chrono" && f?.short_desc === "Court" && f?.description === "<p>Longue description</p>");
  check("live brand name is joined", f?.brand_name === "Maison Vbw");
  check(
    "categories: primary first, then by name; the soft-deleted one is excluded",
    same(f?.category_names, ["Zeta Montres", "Alpha Montres"]),
  );
  check(
    "caractéristiques: assignments ∪ scalars as sorted « Nom : Valeur » pairs",
    same(f?.attribute_pairs, ["Boîtier : Acier", "Boîtier : Or", "Mouvement : Automatique"]),
  );
  check(
    "an INACTIVE attribute contributes nothing (neither value nor scalar)",
    !(f?.attribute_pairs ?? []).some((p) => p.startsWith("Inactif")),
  );
  check("an empty scalar contributes nothing", !(f?.attribute_pairs ?? []).some((p) => p.startsWith("Réserve")));
  check("fresh product has no fingerprint yet", f?.embedding_input_hash === null);
  const b = byId.get(bare);
  check("soft-deleted brand → brand_name null", b !== undefined && b.brand_name === null);
  check("no categories → null (not an empty array)", b !== undefined && b.category_names === null);
  check("no attributes → null", b !== undefined && b.attribute_pairs === null);
  check("empty short / description come back as-is", b?.short_desc === "" && b?.description === "");

  // ── 2. writeProductEmbeddings ──────────────────────────────────────────────
  console.log("writeProductEmbeddings — pgvector bulk UPDATE round-trip:");
  await writeProductEmbeddings([]);
  check("empty batch is a no-op", (await stored(full)).axes === null);

  await writeProductEmbeddings([
    { id: full, vecLiteral: vec(0.5, -0.25), hash: "ztestmodel|v2|full-1" },
    { id: bare, vecLiteral: vec(-1, 0.75), hash: "ztestmodel|v2|bare-1" },
    { id: randomUUID(), vecLiteral: vec(1, 1), hash: "ztestmodel|v2|ghost" }, // no such product
  ]);
  const sFull = await stored(full);
  const sBare = await stored(bare);
  check(`full dimension stored (${sFull.dim})`, sFull.dim === EMBEDDING_DIM);
  check("item 1 vector round-trips", sFull.axes?.[0] === 0.5 && sFull.axes?.[1] === -0.25);
  check("item 1 fingerprint written", sFull.hash === "ztestmodel|v2|full-1");
  check("item 2 vector round-trips (same statement)", sBare.axes?.[0] === -1 && sBare.axes?.[1] === 0.75);
  check("item 2 fingerprint written", sBare.hash === "ztestmodel|v2|bare-1");
  const sControl = await stored(control);
  check("a product outside the batch is untouched", sControl.axes === null && sControl.hash === null);
  check(
    "the reader now sees the new fingerprint (hash gate input)",
    (await readProductTextRows([full]))[0]?.embedding_input_hash === "ztestmodel|v2|full-1",
  );

  await writeProductEmbeddings([{ id: full, vecLiteral: vec(0.125, 0.5), hash: "ztestmodel|v2|full-2" }]);
  const sFull2 = await stored(full);
  check("a re-write overwrites vector + fingerprint", sFull2.axes?.[0] === 0.125 && sFull2.axes?.[1] === 0.5 && sFull2.hash === "ztestmodel|v2|full-2");
  check("…and leaves the other row as it was", (await stored(bare)).hash === "ztestmodel|v2|bare-1");

  let wrongDimRefused = false;
  try {
    await writeProductEmbeddings([{ id: control, vecLiteral: vec(1, 0, 3), hash: "ztestmodel|v2|bad" }]);
  } catch {
    wrongDimRefused = true;
  }
  check("a wrong-dimension vector is refused by vector(1536)", wrongDimRefused);
  check("…and nothing was stored for it", (await stored(control)).hash === null);

  // ── 3. markProductsNeedEmbedding ────────────────────────────────────────────
  console.log("markProductsNeedEmbedding — fingerprint reset keeps the vector:");
  await markProductsNeedEmbedding([full]);
  const sMarked = await stored(full);
  check("fingerprint NULLed (re-enters the backfill needing-set)", sMarked.hash === null);
  check("stale vector kept (search keeps working)", sMarked.axes?.[0] === 0.125);
  check("other rows keep their fingerprint", (await stored(bare)).hash === "ztestmodel|v2|bare-1");

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
      /* best-effort cleanup */
    }
    process.exit(1);
  })
  .then(() => process.exit(0));
