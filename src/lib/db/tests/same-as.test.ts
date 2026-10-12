/**
 * Pure product-sameAs helpers — parse/validate the per-product official-URL
 * field into a clean schema.org Product.sameAs list. No DB, runs without Docker.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/same-as.test.ts
 */
import { parseSameAs, MAX_SAME_AS } from "@/lib/seo/same-as";

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
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function main() {
  console.log("parseSameAs:");
  check("null → []", eq(parseSameAs(null), []));
  check("undefined → []", eq(parseSameAs(undefined), []));
  check("empty/whitespace → []", eq(parseSameAs("   \n  "), []));
  check(
    "single https URL",
    eq(parseSameAs("https://www.sony.com/playstation"), ["https://www.sony.com/playstation"]),
  );
  check("http URL kept", eq(parseSameAs("http://example.com/p"), ["http://example.com/p"]));
  check(
    "newline-separated list, order preserved",
    eq(parseSameAs("https://a.com/1\nhttps://b.com/2"), ["https://a.com/1", "https://b.com/2"]),
  );
  check(
    "comma-separated list",
    eq(parseSameAs("https://a.com/1, https://b.com/2"), ["https://a.com/1", "https://b.com/2"]),
  );
  check(
    "mixed newline + comma + CRLF + blank lines",
    eq(parseSameAs("https://a.com/1,\r\n\nhttps://b.com/2\n"), [
      "https://a.com/1",
      "https://b.com/2",
    ]),
  );
  check("relative URL dropped", eq(parseSameAs("/products/foo\nhttps://a.com/1"), ["https://a.com/1"]));
  check("mailto: dropped", eq(parseSameAs("mailto:foo@bar.com"), []));
  check("javascript: dropped (XSS)", eq(parseSameAs("javascript:alert(1)"), []));
  check("data: dropped", eq(parseSameAs("data:text/html,<script>"), []));
  check("ftp: dropped", eq(parseSameAs("ftp://files.example.com/x"), []));
  check("garbage token dropped", eq(parseSameAs("not a url at all"), []));
  check(
    "duplicates collapsed (normalized)",
    eq(parseSameAs("https://a.com/1\nhttps://a.com/1"), ["https://a.com/1"]),
  );
  check(
    "URL normalized by WHATWG URL (adds path slash)",
    eq(parseSameAs("https://a.com"), ["https://a.com/"]),
  );
  check(
    `capped at MAX_SAME_AS (${MAX_SAME_AS})`,
    parseSameAs(Array.from({ length: 25 }, (_, i) => `https://a.com/${i}`).join("\n")).length ===
      MAX_SAME_AS,
  );

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
