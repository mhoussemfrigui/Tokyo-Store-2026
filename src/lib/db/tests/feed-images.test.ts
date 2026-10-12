/**
 * Pure unit tests for the feed image helpers (absolutize / placeholder-skip /
 * gallery dedup). NO DB. Guards the re-analysis fixes: imageless products must be
 * skipped (placeholder.svg leaked before), and a variant's primary must not repeat
 * in its additional-image gallery.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/feed-images.test.ts
 */
import { absolutize, realImage, feedGallery } from "@/lib/seo/feeds/images";

const PLACEHOLDER = "/placeholder.svg";
const ORIGIN = "https://tokyostore.tn";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

console.log("feed-images:");

// ── absolutize
ok("absolute http(s) passed through", absolutize("https://x.tn/a.jpg", ORIGIN) === "https://x.tn/a.jpg");
ok("relative joined to origin", absolutize("/img/a.jpg", ORIGIN) === "https://tokyostore.tn/img/a.jpg");
ok("missing leading slash still joins", absolutize("img/a.jpg", ORIGIN) === "https://tokyostore.tn/img/a.jpg");
ok("null → null", absolutize(null, ORIGIN) === null);
ok("no origin for a relative URL → null", absolutize("/a.jpg", "") === null);

// ── realImage (the F1 fix: placeholder is NOT a real image)
ok("placeholder → null (imageless product skipped)", realImage(PLACEHOLDER, ORIGIN, PLACEHOLDER) === null);
ok("absolutized placeholder NEVER produced", realImage(PLACEHOLDER, ORIGIN, PLACEHOLDER) !== `${ORIGIN}/placeholder.svg`);
ok("real relative image absolutized", realImage("/img/p.jpg", ORIGIN, PLACEHOLDER) === "https://tokyostore.tn/img/p.jpg");
ok("empty → null", realImage("", ORIGIN, PLACEHOLDER) === null && realImage(undefined, ORIGIN, PLACEHOLDER) === null);

// ── feedGallery (the F3 fix: dedup against the row's primary, drop placeholder)
const primary = "https://tokyostore.tn/img/main.jpg";
const g1 = feedGallery(
  ["/img/main.jpg", "/img/2.jpg", PLACEHOLDER, null, "/img/3.jpg"],
  ORIGIN,
  primary,
  PLACEHOLDER,
);
ok("primary excluded from gallery", !g1.includes(primary));
ok("placeholder excluded from gallery", !g1.some((u) => u.endsWith("/placeholder.svg")));
ok("real extras kept + absolutized", g1.includes("https://tokyostore.tn/img/2.jpg") && g1.includes("https://tokyostore.tn/img/3.jpg"));
ok("gallery has exactly the 2 real extras", g1.length === 2);

// variant scenario: the variant's own image is gallery[1], must be deduped as the row primary
const variantPrimary = "https://tokyostore.tn/img/2.jpg";
const g2 = feedGallery(["/img/main.jpg", "/img/2.jpg", "/img/3.jpg"], ORIGIN, variantPrimary, PLACEHOLDER);
ok("variant primary deduped from its gallery", !g2.includes(variantPrimary) && g2.length === 2);

// cap at 10
const many = Array.from({ length: 15 }, (_, i) => `/img/${i}.jpg`);
ok("gallery capped at 10", feedGallery(many, ORIGIN, null, PLACEHOLDER).length === 10);

console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
process.exit(0);
