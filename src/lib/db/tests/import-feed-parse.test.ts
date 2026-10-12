/**
 * Pure Google/RSS product-feed parser (src/lib/import/parse-google-feed.ts) —
 * the production demo-import path — plus the residual-entity decoder
 * (src/lib/import/types.ts decodeEntities). No DB.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/import-feed-parse.test.ts
 */
import { parseGoogleFeed } from "@/lib/import/parse-google-feed";
import { decodeEntities } from "@/lib/import/types";

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

const FEED = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<rss xmlns:g="http://base.google.com/ns/1.0"><channel>',
  "<item>",
  "<g:id>10</g:id>",
  "<g:title>Manette DualSense</g:title>",
  "<g:price>199.900 TND</g:price>",
  "<g:link>https://tokyostore.tn/accessoires-ps5/10-manette-dualsense.html</g:link>",
  "<g:availability>in stock</g:availability>",
  "<g:brand>Sony</g:brand>",
  "<g:image_link>https://x/a.jpg</g:image_link>",
  "</item>",
  "<item>", // second item: no title → a row error, not a product
  "<g:id>11</g:id>",
  "<g:price>50</g:price>",
  "<g:link>https://x/11-sans-titre.html</g:link>",
  "</item>",
  "</channel></rss>",
].join("\n");

function main() {
  console.log("parseGoogleFeed — happy path + row error:");
  const out = parseGoogleFeed(FEED);
  check("1 valid product parsed", out.products.length === 1);
  check("title-less item → 1 rowError (not a product)", out.rowErrors.length === 1);
  const p = out.products[0];
  check("title", p.title === "Manette DualSense");
  check("price → millimes", p.priceMinor === 199900);
  check("slug from link basename (id + .html stripped)", p.slug === "manette-dualsense");
  check("brand", p.brandName === "Sony");
  check("availability normalized", p.availability === "in_stock");
  check("image captured", p.imageUrls.length === 1);

  console.log("parseGoogleFeed — UTF-8 BOM tolerance:");
  const bomOut = parseGoogleFeed("﻿" + FEED);
  check("BOM-prefixed feed still parses", bomOut.products.length === 1);

  console.log("parseGoogleFeed — invalid XML throws:");
  let threw = false;
  try {
    parseGoogleFeed("<rss><channel><item>oops");
  } catch {
    threw = true;
  }
  check("malformed XML throws", threw);

  console.log("decodeEntities — residual feed entities:");
  check("double-encoded apostrophe", decodeEntities("Assassin&amp;#039;s Creed") === "Assassin's Creed");
  check("named ampersand", decodeEntities("Tom &amp; Jerry") === "Tom & Jerry");
  check("numeric decimal", decodeEntities("&#039;") === "'");
  check("numeric hex", decodeEntities("&#x27;") === "'");
  check("plain text untouched", decodeEntities("Zelda") === "Zelda");

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
