/**
 * Pure unit tests for the review-policy resolver (src/modules/catalog/review/config-parse.ts)
 * — the asBool truth-table + defaults behind the `reviews.*` settings. No DB — fast lane.
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/review-config.test.ts
 */
import { asBool } from "@/lib/cms/setting-coerce";
import { resolveReviewConfig } from "@/modules/catalog/review/config-parse";

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
  console.log("asBool:");
  for (const t of ["true", "1", "yes", "on", "TRUE", " On "]) check(`'${t}' → true`, asBool(t, false) === true);
  for (const f of ["false", "0", "no", "off", "OFF", " No "]) check(`'${f}' → false`, asBool(f, true) === false);
  check("null → fallback (true)", asBool(null, true) === true);
  check("undefined → fallback (false)", asBool(undefined, false) === false);
  check("garbage → fallback", asBool("maybe", true) === true && asBool("maybe", false) === false);
  check("empty string → fallback", asBool("", true) === true);

  console.log("resolveReviewConfig defaults:");
  const def = resolveReviewConfig({});
  check(
    "empty map → enabled/all/moderated/rating=all",
    def.enabled === true &&
      def.policy === "all" &&
      def.requireApproval === true &&
      def.ratingSource === "all",
  );

  console.log("resolveReviewConfig overrides:");
  check(
    "buyers_only policy honoured, others off",
    (() => {
      const c = resolveReviewConfig({
        "reviews.enabled": "false",
        "reviews.policy": "buyers_only",
        "reviews.require_approval": "0",
      });
      return c.enabled === false && c.policy === "buyers_only" && c.requireApproval === false;
    })(),
  );
  check(
    "unknown policy → 'all'",
    resolveReviewConfig({ "reviews.policy": "friends_only" }).policy === "all",
  );
  check(
    "blank policy → 'all'",
    resolveReviewConfig({ "reviews.policy": "  " }).policy === "all",
  );

  console.log("resolveReviewConfig rating source:");
  check(
    "'customers' honoured",
    resolveReviewConfig({ "reviews.rating_source": "customers" }).ratingSource === "customers",
  );
  check(
    "explicit 'all' honoured",
    resolveReviewConfig({ "reviews.rating_source": "all" }).ratingSource === "all",
  );
  check(
    "unknown rating source → 'all'",
    resolveReviewConfig({ "reviews.rating_source": "genuine" }).ratingSource === "all",
  );
  check(
    "blank rating source → 'all'",
    resolveReviewConfig({ "reviews.rating_source": "  " }).ratingSource === "all",
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
