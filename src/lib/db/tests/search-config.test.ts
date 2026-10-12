/**
 * Pure search-engine config parsing (parse-config.ts) — defaults from an empty
 * map, numeric clamps (min length, threshold, weights, semantic floor, limits,
 * purge window), per-kind toggle coercion, the narrow query-config projection
 * and the query-length cap. No DB (that's why parse-config is split out of the
 * server-only config.ts).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/search-config.test.ts
 */
import {
  resolveSearchConfig,
  toQueryConfig,
  clampSearchQuery,
  MAX_SEARCH_QUERY_LENGTH,
  needsTrigramTx,
  PG_DEFAULT_TRGM_THRESHOLD,
  SEARCH_DEFAULTS,
  SEARCH_KINDS,
} from "@/modules/search/parse-config";

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
  console.log("defaults (empty map):");
  const d = resolveSearchConfig({});
  check("minQueryLength → 2", d.minQueryLength === 2);
  check("trigramThreshold → 0.3", d.trigramThreshold === 0.3);
  check("weights → 2 / 1", d.weightName === 2 && d.weightDesc === 1);
  check("resultLimit → 24", d.resultLimit === 24);
  check("autocompleteLimit → 6", d.autocompleteLimit === 6);
  check("purgeMonths → 3", d.purgeMonths === 3);
  check("showOutOfStock → true", d.showOutOfStock === true);
  check("semanticMinSimilarity → 0.35", d.semanticMinSimilarity === 0.35);
  check(
    "all kinds enabled by default",
    SEARCH_KINDS.every((k) => d.kinds[k] === true),
  );
  check("matches SEARCH_DEFAULTS", JSON.stringify(d) === JSON.stringify(SEARCH_DEFAULTS));

  console.log("numeric clamps:");
  check(
    "min_query_length clamps to [1,4] (high)",
    resolveSearchConfig({ "search.min_query_length": "99" }).minQueryLength === 4,
  );
  check(
    "min_query_length clamps to [1,4] (low/zero)",
    resolveSearchConfig({ "search.min_query_length": "0" }).minQueryLength === 1,
  );
  check(
    "trigram_threshold clamps to [0.1,0.6] (high)",
    resolveSearchConfig({ "search.trigram_threshold": "0.95" }).trigramThreshold === 0.6,
  );
  check(
    "trigram_threshold clamps to [0.1,0.6] (low/negative)",
    resolveSearchConfig({ "search.trigram_threshold": "-1" }).trigramThreshold === 0.1,
  );
  check(
    "weights clamp to [0,10]",
    resolveSearchConfig({ "search.weight_name": "50", "search.weight_desc": "-5" }).weightName === 10 &&
      resolveSearchConfig({ "search.weight_desc": "-5" }).weightDesc === 0,
  );
  check(
    "result_limit clamps to [1,50]",
    resolveSearchConfig({ "search.result_limit": "9999" }).resultLimit === 50 &&
      resolveSearchConfig({ "search.result_limit": "0" }).resultLimit === 1,
  );
  check(
    "autocomplete_limit clamps to [1,25]",
    resolveSearchConfig({ "search.autocomplete_limit": "999" }).autocompleteLimit === 25 &&
      resolveSearchConfig({ "search.autocomplete_limit": "0" }).autocompleteLimit === 1,
  );
  check(
    "semantic_min_similarity clamps to [0,0.9]",
    resolveSearchConfig({ "search.semantic_min_similarity": "5" }).semanticMinSimilarity === 0.9 &&
      resolveSearchConfig({ "search.semantic_min_similarity": "-0.2" }).semanticMinSimilarity === 0,
  );
  check(
    "semantic_min_similarity 0.42 kept un-rounded",
    resolveSearchConfig({ "search.semantic_min_similarity": "0.42" }).semanticMinSimilarity === 0.42,
  );
  check(
    "semantic_min_similarity junk → default",
    resolveSearchConfig({ "search.semantic_min_similarity": "abc" }).semanticMinSimilarity === 0.35,
  );
  check(
    "purge_months clamps to [1,24]",
    resolveSearchConfig({ "search.purge_months": "240" }).purgeMonths === 24 &&
      resolveSearchConfig({ "search.purge_months": "0" }).purgeMonths === 1,
  );

  console.log("fractional weights/threshold preserved (clamp, not clampInt):");
  check(
    "weight 2.5 kept un-rounded",
    resolveSearchConfig({ "search.weight_name": "2.5" }).weightName === 2.5,
  );
  check(
    "weight 1.5 kept un-rounded",
    resolveSearchConfig({ "search.weight_desc": "1.5" }).weightDesc === 1.5,
  );
  check(
    "threshold 0.35 kept un-rounded",
    resolveSearchConfig({ "search.trigram_threshold": "0.35" }).trigramThreshold === 0.35,
  );

  console.log("integer rounding (settings are free text):");
  check(
    "result_limit rounds 23.9 → 24",
    resolveSearchConfig({ "search.result_limit": "23.9" }).resultLimit === 24,
  );
  check(
    "min_query_length rounds 2.4 → 2",
    resolveSearchConfig({ "search.min_query_length": "2.4" }).minQueryLength === 2,
  );

  console.log("non-finite / junk → fallback:");
  check(
    "junk weight → default",
    resolveSearchConfig({ "search.weight_name": "abc" }).weightName === 2,
  );
  check(
    "empty string → default",
    resolveSearchConfig({ "search.result_limit": "" }).resultLimit === 24,
  );
  check(
    "null value → default",
    resolveSearchConfig({ "search.purge_months": null }).purgeMonths === 3,
  );

  console.log("per-kind toggles:");
  check(
    "kind_product off",
    resolveSearchConfig({ "search.kind_product": "off" }).kinds.product === false,
  );
  check(
    "kind_blog_post false leaves others true",
    resolveSearchConfig({ "search.kind_blog_post": "false" }).kinds.blog_post === false &&
      resolveSearchConfig({ "search.kind_blog_post": "false" }).kinds.product === true,
  );
  check(
    "kind junk → default true",
    resolveSearchConfig({ "search.kind_page": "maybe" }).kinds.page === true,
  );

  console.log("showOutOfStock coercion:");
  check(
    "show_out_of_stock off → false",
    resolveSearchConfig({ "search.show_out_of_stock": "off" }).showOutOfStock === false,
  );
  check(
    "show_out_of_stock 1 → true",
    resolveSearchConfig({ "search.show_out_of_stock": "1" }).showOutOfStock === true,
  );

  console.log("toQueryConfig projection:");
  const qc = toQueryConfig(
    resolveSearchConfig({
      "search.weight_name": "4",
      "search.weight_desc": "2",
      "search.trigram_threshold": "0.4",
      "search.show_out_of_stock": "off",
      "search.result_limit": "10",
      "search.semantic_min_similarity": "0.5",
    }),
  );
  check(
    "carries scoring knobs only",
    qc.weightName === 4 &&
      qc.weightDesc === 2 &&
      qc.trigramThreshold === 0.4 &&
      qc.showOutOfStock === false &&
      qc.semanticEnabled === false &&
      qc.weightSemantic === 1 &&
      qc.semanticMinSimilarity === 0.5 &&
      !("resultLimit" in qc) &&
      !("kinds" in qc),
  );
  // toQueryConfig(SEARCH_DEFAULTS) is the single source for queries.ts'
  // DEFAULT_QUERY_CONFIG — lock that the projection matches the defaults so the
  // dedup can't silently drift. Semantic knobs default OFF (safe-by-default).
  check(
    "toQueryConfig(SEARCH_DEFAULTS) == default scoring knobs",
    JSON.stringify(toQueryConfig(SEARCH_DEFAULTS)) ===
      JSON.stringify({
        weightName: 2,
        weightDesc: 1,
        trigramThreshold: 0.3,
        showOutOfStock: true,
        semanticEnabled: false,
        weightSemantic: 1,
        semanticMinSimilarity: 0.35,
      }),
  );

  console.log("all kinds disabled:");
  const allOff: Record<string, string> = {};
  for (const k of SEARCH_KINDS) allOff[`search.kind_${k}`] = "off";
  check(
    "every kind resolves false",
    SEARCH_KINDS.every((k) => resolveSearchConfig(allOff).kinds[k] === false),
  );

  console.log("needsTrigramTx (default = no transaction):");
  check("PG_DEFAULT_TRGM_THRESHOLD is 0.3", PG_DEFAULT_TRGM_THRESHOLD === 0.3);
  check("0.3 → false (pooled fast path)", needsTrigramTx(0.3) === false);
  check(
    "resolved default threshold → false",
    needsTrigramTx(resolveSearchConfig({}).trigramThreshold) === false,
  );
  check("float-drift 0.3000000001 → false (epsilon)", needsTrigramTx(0.3000000001) === false);
  check("0.1 → true", needsTrigramTx(0.1) === true);
  check("0.6 → true", needsTrigramTx(0.6) === true);
  check("0.35 → true", needsTrigramTx(0.35) === true);

  console.log("clampSearchQuery (length cap for the service + /recherche):");
  check("MAX_SEARCH_QUERY_LENGTH is 150", MAX_SEARCH_QUERY_LENGTH === 150);
  check("short query only trimmed", clampSearchQuery("  montre acier  ") === "montre acier");
  const huge = clampSearchQuery("a".repeat(5000));
  check("5000-char query capped at the max", huge.length === MAX_SEARCH_QUERY_LENGTH);
  check("idempotent", clampSearchQuery(huge) === huge);
  check(
    "exactly-max query kept whole",
    clampSearchQuery("b".repeat(MAX_SEARCH_QUERY_LENGTH)).length === MAX_SEARCH_QUERY_LENGTH,
  );
  // 149 ASCII chars + an emoji (2 UTF-16 units) straddle the cut: the lone high
  // surrogate must be dropped, never emitted as an invalid string.
  const straddle = clampSearchQuery(`${"c".repeat(MAX_SEARCH_QUERY_LENGTH - 1)}🕰xyz`);
  const lastUnit = straddle.charCodeAt(straddle.length - 1);
  check(
    "never ends on a lone high surrogate",
    straddle === "c".repeat(MAX_SEARCH_QUERY_LENGTH - 1) && !(lastUnit >= 0xd800 && lastUnit <= 0xdbff),
  );
  check(
    "whitespace exposed by the cut is re-trimmed",
    clampSearchQuery(`${"d".repeat(MAX_SEARCH_QUERY_LENGTH - 1)}   tail`) ===
      "d".repeat(MAX_SEARCH_QUERY_LENGTH - 1),
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
