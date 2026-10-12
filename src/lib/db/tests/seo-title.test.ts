/**
 * Pure SEO title helpers — the brand-suffix de-duplication that fixes the crawl's
 * "… · Tokyo Store · Tokyo Store" titles. No DB, runs without Docker.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/seo-title.test.ts
 */
import { stripBrandFromTitle, composeTitle } from "@/lib/seo/title";

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

const BRAND = "Tokyo Store";

function main() {
  console.log("stripBrandFromTitle:");
  check("no brand → unchanged", stripBrandFromTitle("Spider-Man: Miles Morales", BRAND) === "Spider-Man: Miles Morales");
  check("trailing middot suffix stripped", stripBrandFromTitle("Nintendo Switch · Tokyo Store", BRAND) === "Nintendo Switch");
  check(
    "DOUBLED suffix collapsed",
    stripBrandFromTitle("Meta · Tokyo Store · Tokyo Store", BRAND) === "Meta",
  );
  check("pipe suffix stripped", stripBrandFromTitle("EA Sports FC 26 PS5 | Tokyo Store", BRAND) === "EA Sports FC 26 PS5");
  check("em-dash suffix stripped", stripBrandFromTitle("Pokémon Épée — Tokyo Store", BRAND) === "Pokémon Épée");
  check("hyphen-space suffix stripped", stripBrandFromTitle("Mario - Tokyo Store", BRAND) === "Mario");
  check("leading brand prefix stripped", stripBrandFromTitle("Tokyo Store | Princess Peach", BRAND) === "Princess Peach");
  check(
    "hyphen INSIDE a name is preserved",
    stripBrandFromTitle("Spider-Man: Miles Morales - Jeux PS5 | Tokyo Store", BRAND) ===
      "Spider-Man: Miles Morales - Jeux PS5",
  );
  check("only-brand → falls back to original (never empty)", stripBrandFromTitle("Tokyo Store", BRAND) === "Tokyo Store");
  check("empty siteName → unchanged", stripBrandFromTitle("Some Title · Foo", "") === "Some Title · Foo");
  check("trims whitespace", stripBrandFromTitle("  Consoles  ", BRAND) === "Consoles");

  console.log("composeTitle:");
  const TPL = "%s · Tokyo Store";
  check("plain title templated once", composeTitle("Consoles", BRAND, TPL) === "Consoles · Tokyo Store");
  check(
    "already-suffixed title not doubled",
    composeTitle("Consoles · Tokyo Store", BRAND, TPL) === "Consoles · Tokyo Store",
  );
  check(
    "tripled input collapses to single",
    composeTitle("Meta · Tokyo Store · Tokyo Store", BRAND, TPL) === "Meta · Tokyo Store",
  );
  check(
    "leading-brand input cleaned then templated",
    composeTitle("Tokyo Store | Princess Peach", BRAND, TPL) === "Princess Peach · Tokyo Store",
  );
  check("template without %s returns cleaned title", composeTitle("Foo · Tokyo Store", BRAND, "GZ") === "Foo");

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
