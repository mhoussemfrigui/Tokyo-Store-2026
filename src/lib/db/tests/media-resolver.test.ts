/**
 * Media URL resolvers — the AVIF-first DISPLAY chain vs the AVIF-AVOIDING
 * thumb/social chains, the empty-string skip, and url_override precedence.
 * Pure (no DB): the resolvers read a default same-origin CDN base.
 *
 * These invariants are load-bearing: ~70 call sites + every OG/JSON-LD tag
 * depend on display=AVIF-first and thumb/social=never-AVIF. A silent reorder
 * (e.g. social preferring avif_url) would ship a broken og:image to Facebook /
 * LinkedIn with nothing else catching it.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/media-resolver.test.ts
 */
import {
  resolveMediaAlt,
  resolveMediaSocialUrl,
  resolveMediaThumbUrl,
  resolveMediaUrl,
} from "@/modules/media/url-resolver";

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

/** A full media row with every variant URL set. */
const full = {
  url_override: null,
  avif_url: "/cdn/products/x.avif",
  webp_url: "/cdn/products/x.webp",
  url: "/cdn/products/x.jpg",
  original_url: "/cdn/products/x.original.png",
};

function main() {
  console.log("resolveMediaUrl — DISPLAY (AVIF-first):");
  check("prefers avif_url", resolveMediaUrl(full)?.endsWith("x.avif") === true);
  check(
    "falls to webp when avif empty",
    resolveMediaUrl({ ...full, avif_url: "" })?.endsWith("x.webp") === true,
  );
  check(
    "falls to url when avif+webp empty",
    resolveMediaUrl({ ...full, avif_url: "", webp_url: "" })?.endsWith("x.jpg") === true,
  );
  check(
    "falls to original when only original set",
    resolveMediaUrl({
      url_override: null,
      avif_url: null,
      webp_url: null,
      url: "",
      original_url: "/cdn/products/x.original.png",
    })?.endsWith("x.original.png") === true,
  );

  console.log("resolveMediaThumbUrl / resolveMediaSocialUrl — NEVER AVIF:");
  check("thumb prefers webp, not avif", resolveMediaThumbUrl(full)?.endsWith("x.webp") === true);
  check("social prefers webp, not avif", resolveMediaSocialUrl(full)?.endsWith("x.webp") === true);
  check(
    "thumb never returns the avif even if it's the only variant besides original",
    resolveMediaThumbUrl({
      url_override: null,
      avif_url: "/cdn/products/x.avif",
      webp_url: null,
      url: "",
      original_url: "/cdn/products/x.original.png",
    })?.endsWith("x.original.png") === true,
  );
  check(
    "social == thumb (lock-step delegation)",
    resolveMediaSocialUrl(full) === resolveMediaThumbUrl(full),
  );

  console.log("url_override — wins for all three resolvers:");
  const pinned = { ...full, url_override: "/cdn/override/o.jpg" };
  check("display honours override", resolveMediaUrl(pinned)?.endsWith("o.jpg") === true);
  check("thumb honours override", resolveMediaThumbUrl(pinned)?.endsWith("o.jpg") === true);
  check("social honours override", resolveMediaSocialUrl(pinned)?.endsWith("o.jpg") === true);
  check(
    "empty-string override does NOT short-circuit",
    resolveMediaUrl({ ...full, url_override: "" })?.endsWith("x.avif") === true,
  );
  check(
    "whitespace-only override is skipped",
    resolveMediaUrl({ ...full, url_override: "   " })?.endsWith("x.avif") === true,
  );

  console.log("null / empty rows:");
  check("null row → null (display)", resolveMediaUrl(null) === null);
  check("undefined row → null (thumb)", resolveMediaThumbUrl(undefined) === null);
  check("null row → null (social)", resolveMediaSocialUrl(null) === null);
  check(
    "row with all-empty fields → null",
    resolveMediaUrl({
      url_override: "",
      avif_url: "",
      webp_url: "",
      url: "",
      original_url: "",
    }) === null,
  );

  console.log("resolveMediaAlt:");
  check("trims alt_text", resolveMediaAlt({ alt_text: "  Montre or  " }) === "Montre or");
  check("whitespace-only → null", resolveMediaAlt({ alt_text: "   " }) === null);
  check("empty → null", resolveMediaAlt({ alt_text: "" }) === null);
  check("missing → null", resolveMediaAlt({}) === null);
  check("null row → null", resolveMediaAlt(null) === null);

  console.log(`\nmedia-resolver: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
