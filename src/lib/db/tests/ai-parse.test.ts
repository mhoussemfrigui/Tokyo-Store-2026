/**
 * Pure AI helpers — the brittle layer around the AI provider still used by
 * semantic search (embeddings) + the SEO feed/doc text extraction. No DB /
 * network, so this runs without Docker.
 *
 *  • extractJson — fences, prose around the value, trailing junk after it,
 *    nested/array shapes, brackets inside strings, garbage → null.
 *  • htmlToText — tag/entity stripping, whitespace collapse, clamp.
 *  • mapWithConcurrency — full coverage, bounded in-flight, count=0 no-op.
 *  • buildUserMessage — key: value lines, empty/null fields dropped, values trimmed.
 *  • validateAiBaseUrl — SSRF guard for the provider base URL (public ok;
 *    cloud-metadata / link-local / non-http blocked).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/ai-parse.test.ts
 */
import { buildUserMessage, extractJson, htmlToText, mapWithConcurrency } from "@/lib/ai/parse";
import { validateAiBaseUrl } from "@/lib/ai/validate-base-url";

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

async function main() {
  /* ───────────── extractJson ───────────── */
  console.log("extractJson:");
  check("plain object", extractJson<{ a: number }>('{"a":1}')?.a === 1);
  check(
    "fenced ```json block",
    extractJson<{ a: number }>('```json\n{"a":2}\n```')?.a === 2,
  );
  check("bare ``` fence", extractJson<{ a: number }>('```\n{"a":3}\n```')?.a === 3);
  check(
    "prose before AND after the value",
    extractJson<{ ok: boolean }>('Voici le résultat : {"ok":true}. Merci !')?.ok === true,
  );
  check(
    "trailing second object ignored (balanced)",
    extractJson<{ a: number }>('{"a":1} then garbage {"b":2}')?.a === 1,
  );
  check(
    "array of objects",
    extractJson<number[]>("[1,2,3]")?.length === 3,
  );
  check(
    "nested object preserved",
    extractJson<{ x: { y: number } }>('{"x":{"y":9}}')?.x.y === 9,
  );
  check(
    "brackets inside a string don't end the value early",
    extractJson<{ s: string }>('{"s":"a } b ] c"}')?.s === "a } b ] c",
  );
  check(
    "escaped quote inside a string",
    extractJson<{ s: string }>('{"s":"he said \\"hi\\""}')?.s === 'he said "hi"',
  );
  check("garbage → null", extractJson("not json at all") === null);
  check("empty string → null", extractJson("") === null);
  check(
    "truncated object → null (no fallback parses)",
    extractJson('{"a":1, "b":') === null,
  );
  check(
    "array preferred when it appears first",
    Array.isArray(extractJson<unknown>('[{"a":1}]')),
  );

  /* ───────────── htmlToText ───────────── */
  console.log("htmlToText:");
  check("strips tags", htmlToText("<p>Hello <b>world</b></p>") === "Hello world");
  check("decodes/strips entities", htmlToText("a&nbsp;b&amp;c") === "a b c");
  check("collapses whitespace", htmlToText("a\n\n   b\t c") === "a b c");
  check("null/undefined → empty", htmlToText(null) === "" && htmlToText(undefined) === "");
  const clamped = htmlToText("x".repeat(50), 10);
  check("clamps + ellipsis", clamped.length === 11 && clamped.endsWith("…"));
  check("no clamp when under max", htmlToText("short", 100) === "short");

  /* ───────────── mapWithConcurrency ───────────── */
  console.log("mapWithConcurrency:");
  {
    const done: number[] = [];
    await mapWithConcurrency(7, 3, async (i) => {
      done.push(i);
    });
    check(
      "runs every index exactly once",
      done.length === 7 && new Set(done).size === 7 && [0, 1, 2, 3, 4, 5, 6].every((n) => done.includes(n)),
    );
  }
  {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(20, 4, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
    });
    check("never exceeds the concurrency limit", maxInFlight <= 4 && maxInFlight > 0);
  }
  {
    let calls = 0;
    await mapWithConcurrency(0, 4, async () => {
      calls += 1;
    });
    check("count=0 → no calls", calls === 0);
  }

  /* ───────────── buildUserMessage ───────────── */
  console.log("buildUserMessage:");
  check("undefined → empty", buildUserMessage(undefined) === "");
  check(
    "key: value lines, empties skipped",
    buildUserMessage({ Nom: "X", Vide: "", Null: null, Prix: 10 }) === "Nom: X\nPrix: 10",
  );
  check("trims values", buildUserMessage({ A: "  b  " }) === "A: b");

  /* ───────────── validateAiBaseUrl (SSRF guard) ───────────── */
  console.log("validateAiBaseUrl:");
  check("https public ok", validateAiBaseUrl("https://api.anthropic.com") === null);
  check("http localhost ok (self-hosted LLM)", validateAiBaseUrl("http://localhost:11434") === null);
  check("private 10.x ok (internal LLM)", validateAiBaseUrl("http://10.0.0.5:8080/v1") === null);
  check("garbage rejected", validateAiBaseUrl("not a url") !== null);
  check("non-http protocol rejected", validateAiBaseUrl("file:///etc/passwd") !== null);
  check("cloud metadata blocked", validateAiBaseUrl("http://169.254.169.254/latest/meta-data/") !== null);
  check("link-local blocked", validateAiBaseUrl("http://169.254.1.1/") !== null);
  check("gcp metadata host blocked", validateAiBaseUrl("http://metadata.google.internal/") !== null);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
