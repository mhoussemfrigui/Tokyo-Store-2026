/**
 * Pure product-import parsing (src/lib/import/parse-csv.ts + types.ts). No DB.
 * Locks the CSV contract (required headers, delimiter detection, RFC-4180
 * quoting, BOM tolerance, row-error collection, image/availability handling)
 * and the price parser.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/import-parse.test.ts
 */
import { parseCsvProducts } from "@/lib/import/parse-csv";
import { parsePriceToMinor } from "@/lib/import/types";

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
  console.log("parsePriceToMinor (1 TND = 1000 millimes):");
  check("plain integer dinars", parsePriceToMinor("49") === 49000);
  check("dot decimal", parsePriceToMinor("49.900") === 49900);
  check("comma decimal (FR)", parsePriceToMinor("49,900") === 49900);
  check("currency suffix stripped", parsePriceToMinor("49.900 TND") === 49900);
  check("thousands separator", parsePriceToMinor("1.299,000") === 1299000 || parsePriceToMinor("1,299.000") === 1299000);
  check("zero → null", parsePriceToMinor("0") === null);
  // A leading sign is stripped with other non-[0-9.,] chars, so "-5" parses as
  // 5 (positive). Documented contract — negative prices aren't a real feed case.
  check("leading minus stripped → positive", parsePriceToMinor("-5") === 5000);
  check("blank → null", parsePriceToMinor("") === null);
  check("garbage → null", parsePriceToMinor("abc") === null);

  console.log("parseCsvProducts — required headers:");
  let threw = false;
  try {
    parseCsvProducts("foo,bar\n1,2");
  } catch {
    threw = true;
  }
  check("missing name/price_dinars THROWS", threw);

  console.log("parseCsvProducts — happy path (comma delimiter):");
  const csv = [
    "name,price_dinars,brand,category_path,availability,image_url,additional_image_urls",
    'Manette DualSense,199.900,Sony,Playstation 5 / Accessoires PS5,in_stock,https://x/a.jpg,https://x/b.jpg|https://x/c.jpg',
  ].join("\n");
  const out = parseCsvProducts(csv);
  check("one product parsed", out.products.length === 1);
  const p = out.products[0];
  check("title kept", p.title === "Manette DualSense");
  check("slug derived from name", p.slug === "manette-dualsense");
  check("price → millimes", p.priceMinor === 199900);
  check("brand captured", p.brandName === "Sony");
  check("category path split on ' / '", p.categoryPath.length === 2 && p.categoryPath[0] === "Playstation 5");
  check("availability normalized", p.availability === "in_stock");
  check("images merged (image_url + additional split on |), deduped", p.imageUrls.length === 3);

  console.log("parseCsvProducts — UTF-8 BOM tolerance (the Excel-FR fix):");
  const bom = "﻿" + "name;price_dinars\nJeu Switch;59,900";
  const bomOut = parseCsvProducts(bom);
  check("BOM stripped → header recognised, 1 product", bomOut.products.length === 1);
  check("semicolon delimiter auto-detected", bomOut.products[0].priceMinor === 59900);

  console.log("parseCsvProducts — quoting + row errors:");
  const quoted = [
    "name,price_dinars",
    '"Câble, HDMI 2.1",29.900',
    "Sans prix,",
    "Bon produit,15",
  ].join("\n");
  const q = parseCsvProducts(quoted);
  check("quoted field with embedded comma kept whole", q.products.some((x) => x.title === "Câble, HDMI 2.1"));
  check("row with unparseable price → rowError (not a product)", q.rowErrors.length === 1);
  check("valid rows still parsed (2 of 3)", q.products.length === 2);

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
