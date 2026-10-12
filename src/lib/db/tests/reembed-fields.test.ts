/**
 * PURE unit test for the embedding-staleness gate. No DB, no server-only — runs in
 * the `test:pure` chain.
 *
 *   npx tsx --conditions=react-server src/lib/db/tests/reembed-fields.test.ts
 *
 * WHY: changedFieldsAffectEmbedding is the SOLE gate deciding whether a product.updated
 * event re-embeds (or marks-needing) a product. If an embedded field is dropped from
 * EMBEDDING_TEXT_FIELDS, the gate silently returns false → that product's vector drifts
 * permanently stale with no error/log. This pins the field vocabulary + its dual
 * snake_case/camelCase spellings.
 */
import {
  EMBEDDING_TEXT_FIELDS,
  changedFieldsAffectEmbedding,
} from "@/events/subscribers/reembed-fields";

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

function main() {
  console.log("every embedded field triggers a re-embed:");
  for (const f of EMBEDDING_TEXT_FIELDS) {
    check(`« ${f} » → true`, changedFieldsAffectEmbedding([f]) === true);
  }

  console.log("dual spellings both present (the fragile bit):");
  check("snake_case short_desc AND camelCase shortDesc", EMBEDDING_TEXT_FIELDS.includes("short_desc") && EMBEDDING_TEXT_FIELDS.includes("shortDesc"));
  check("both categories AND category", EMBEDDING_TEXT_FIELDS.includes("categories") && EMBEDDING_TEXT_FIELDS.includes("category"));

  console.log("non-embedded fields never trigger:");
  for (const f of ["slug", "price_cents", "is_published", "in_stock", "sku", "old_price_cents", "weight_grams"]) {
    check(`« ${f} » → false`, changedFieldsAffectEmbedding([f]) === false);
  }

  // updateProductWorkflow now reports ONLY the fields that actually changed (and
  // emits nothing for a no-op save) — so these real payload shapes must keep
  // mapping the right way: a stock / publish / price-only save never re-embeds,
  // a brand removal (« Retirer la marque » → ["brand"]) always does.
  console.log("real updateProductWorkflow payload shapes:");
  check("stock-only ['stock_qty','in_stock'] → false", changedFieldsAffectEmbedding(["stock_qty", "in_stock"]) === false);
  check("publish toggle ['is_published'] → false", changedFieldsAffectEmbedding(["is_published"]) === false);
  check("price-only ['old_price_cents','price_cents'] → false", changedFieldsAffectEmbedding(["old_price_cents", "price_cents"]) === false);
  check("brand removal ['brand'] → true", changedFieldsAffectEmbedding(["brand"]) === true);
  check("scalar attribute edit ['attribute_scalars'] → true", changedFieldsAffectEmbedding(["attribute_scalars"]) === true);

  console.log("mixed + empty:");
  check("['price_cents','name'] → true (one embedded field is enough)", changedFieldsAffectEmbedding(["price_cents", "name"]) === true);
  check("['slug','sku'] → false", changedFieldsAffectEmbedding(["slug", "sku"]) === false);
  check("empty array → false", changedFieldsAffectEmbedding([]) === false);
  check("null → false", changedFieldsAffectEmbedding(null) === false);
  check("undefined → false", changedFieldsAffectEmbedding(undefined) === false);

  console.log("hygiene:");
  check("no duplicate entries", new Set(EMBEDDING_TEXT_FIELDS).size === EMBEDDING_TEXT_FIELDS.length);

  console.log(`\nreembed-fields.test.ts — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}

main();
