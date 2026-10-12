/**
 * Pure unit tests for the product AggregateRating / Review[] gating
 * (src/lib/seo/review-jsonld.ts) — the ≥5 threshold + the customers-only source
 * filter that keep fabricated (AI / manual) reviews out of Google structured data
 * and the shopping feeds. No DB — fast lane.
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/review-jsonld.test.ts
 */
import { canEmitAggregateRating, selectStructuredReviews } from "@/lib/seo/review-jsonld";

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

const R = (over: Partial<{ authorName: string | null; rating: number | null; source: string }>) => ({
  authorName: "Alice",
  rating: 5,
  source: "customer",
  ...over,
});

function main() {
  console.log("canEmitAggregateRating:");
  check("enabled + 5 → true", canEmitAggregateRating(true, 5) === true);
  check("enabled + 12 → true", canEmitAggregateRating(true, 12) === true);
  check("enabled + 4 → false (below threshold)", canEmitAggregateRating(true, 4) === false);
  check("enabled + 0 → false", canEmitAggregateRating(true, 0) === false);
  check("enabled + null → false", canEmitAggregateRating(true, null) === false);
  check("enabled + undefined → false", canEmitAggregateRating(true, undefined) === false);
  check("disabled + 100 → false", canEmitAggregateRating(false, 100) === false);

  console.log("selectStructuredReviews — 'all':");
  const mixed = [
    R({ source: "customer" }),
    R({ source: "ai" }),
    R({ source: "manual" }),
  ];
  check("all → keeps every source", selectStructuredReviews(mixed, "all").length === 3);

  console.log("selectStructuredReviews — 'customers':");
  const onlyCustomers = selectStructuredReviews(mixed, "customers");
  check("customers → drops ai + manual", onlyCustomers.length === 1);
  check("customers → keeps the customer row", onlyCustomers[0]?.source === "customer");
  check(
    "customers → all-fabricated yields empty",
    selectStructuredReviews([R({ source: "ai" }), R({ source: "manual" })], "customers").length === 0,
  );

  console.log("selectStructuredReviews — content guards:");
  check(
    "drops missing author",
    selectStructuredReviews([R({ authorName: "" }), R({ authorName: null })], "all").length === 0,
  );
  check(
    "drops missing rating",
    selectStructuredReviews([R({ rating: 0 }), R({ rating: null })], "all").length === 0,
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
