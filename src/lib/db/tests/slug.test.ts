/**
 * slugify + slugSchema (src/lib/slug.ts) — pure, DB-free.
 *
 * Regression guard for the truncation bug: the length cap must be applied
 * BEFORE stripping edge hyphens, or a title whose 80-char cut lands on a
 * separator emits a slug ending in "-" that slugSchema then rejects on save.
 */
import { slugify, slugSchema } from "@/lib/slug";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

check(
  "accents + punctuation → clean slug",
  slugify("Casio G-SHOCK Chronographe (Édition!)") === "casio-g-shock-chronographe-edition",
);
check("collapses + trims surrounding whitespace", slugify("  Hello   World  ") === "hello-world");
check("all-punctuation → empty string", slugify("!!!") === "");
check("empty → empty", slugify("") === "");
check("already-clean slug is unchanged", slugify("casio-g-shock") === "casio-g-shock");

// ── Regression: truncation must not leave a trailing hyphen. A title whose
//    80th char falls on a word boundary previously produced "…-" (invalid).
const truncated = slugify("a".repeat(79) + " b");
check("truncated slug never ends with '-'", !truncated.endsWith("-"));
check("truncated slug never starts with '-'", !truncated.startsWith("-"));
check("truncated slug ≤ 80 chars", truncated.length <= 80);
check("truncated slug passes slugSchema", slugSchema.safeParse(truncated).success === true);

// ── Property sweep over adversarial inputs.
const samples = [
  "Édition Spéciale 2026 !",
  "---weird---",
  "Z".repeat(200),
  "montre & bracelet // cuir",
  "   ",
  "gc-x1",
  "a".repeat(80) + "-x",
];
check(
  "no sample yields a leading/trailing hyphen",
  samples.every((s) => {
    const o = slugify(s);
    return o === "" || (!o.startsWith("-") && !o.endsWith("-"));
  }),
);
check("no sample exceeds 80 chars", samples.every((s) => slugify(s).length <= 80));
check(
  "every non-empty sample slug passes slugSchema",
  samples.every((s) => {
    const o = slugify(s);
    return o === "" || slugSchema.safeParse(o).success === true;
  }),
);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
