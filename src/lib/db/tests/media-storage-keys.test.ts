/**
 * Media storage-key derivation — the FORWARD (variantUploadKeys: base + flags →
 * keys, used by the upload-abort purge) ⇔ REVERSE (variantStorageKeys: row →
 * keys, used by the media.deleted / bulk-delete S3 reap) round-trip.
 *
 * These two MUST derive identical key shapes or a delete leaks bytes / an abort
 * orphans live objects. A real past bug (storage.ts comment) reconstructed the
 * kept original as `${base}.${ext}` instead of `${base}.original.${ext}`, so
 * every media delete leaked its original — this guards against re-introducing it.
 * Also pins `buildStorageKey` sanitising: a dot run ("Rolex..jpg") must never
 * reach a key (the /cdn proxy 400s any `..` segment), nor a base ending in
 * `.original` (that key shape is staff-only on /cdn).
 * Pure (string manipulation only, no DB / S3).
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/media-storage-keys.test.ts
 */
import path from "node:path";

import {
  buildStorageKey,
  variantKey,
  variantStorageKeys,
  variantUploadKeys,
} from "@/modules/media/storage";

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

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

function main() {
  const base = "products/abc-uuid-watch";

  console.log("variantKey — original gets the distinct `.original.` infix:");
  check("primary", variantKey(base, "primary", "jpg") === `${base}.jpg`);
  check("webp", variantKey(base, "webp", "webp") === `${base}.webp`);
  check("avif", variantKey(base, "avif", "avif") === `${base}.avif`);
  check("original", variantKey(base, "original", "png") === `${base}.original.png`);

  console.log("Round-trip — full row (webp + avif + kept PNG original):");
  {
    const forward = variantUploadKeys(base, {
      primaryExt: "jpg",
      webp: true,
      avif: true,
      originalExt: "png",
    });
    const reverse = variantStorageKeys({
      storage_key: `${base}.jpg`,
      webp_url: `/cdn/${base}.webp`,
      avif_url: `/cdn/${base}.avif`,
      original_url: `/cdn/${base}.original.png`,
    });
    const expected = [`${base}.jpg`, `${base}.webp`, `${base}.avif`, `${base}.original.png`];
    check("forward == expected", sameSet(forward, expected));
    check("reverse == expected", sameSet(reverse, expected));
    check("forward == reverse", sameSet(forward, reverse));
  }

  console.log("Round-trip — no webp, no avif (JPEG-only):");
  {
    const forward = variantUploadKeys(base, { primaryExt: "jpg", webp: false, avif: false });
    const reverse = variantStorageKeys({
      storage_key: `${base}.jpg`,
      webp_url: null,
      avif_url: null,
      original_url: null,
    });
    check("forward == reverse", sameSet(forward, reverse));
    check("only the primary key", sameSet(forward, [`${base}.jpg`]));
  }

  console.log("Reverse — original ext parsed out of a URL with a querystring:");
  {
    const reverse = variantStorageKeys({
      storage_key: `${base}.jpg`,
      webp_url: `/cdn/${base}.webp`,
      avif_url: null,
      original_url: `/cdn/${base}.original.webp?v=2`,
    });
    check(
      "original key uses the parsed ext, ignoring the querystring",
      reverse.includes(`${base}.original.webp`),
    );
    check("no avif key when avif_url null", !reverse.includes(`${base}.avif`));
  }

  console.log("Round-trip — GIF where original == primary (no duplicate original):");
  {
    // A kept GIF stores its source AS the primary (no quality-controlled JPEG),
    // so original_url is null on the row → reverse must not invent an original.
    const reverse = variantStorageKeys({
      storage_key: `${base}.gif`,
      webp_url: null,
      avif_url: null,
      original_url: null,
    });
    check("only the gif primary", sameSet(reverse, [`${base}.gif`]));
  }

  console.log("buildStorageKey — dot runs / edge dots / `.original` suffix:");
  {
    const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    const name = (key: string) => key.replace(new RegExp(`^[a-z]+/${UUID}-`), "");
    // The upload workflow feeds `path.parse(file.name).name` (no extension).
    const k1 = buildStorageKey({ scope: "products", filename: path.parse("Rolex..jpg").name });
    check("'Rolex..jpg' → base has no trailing dot", name(k1) === "rolex");
    check(
      "'Rolex..jpg' → primary key has no '..' (servable by /cdn)",
      !variantKey(k1, "primary", "jpg").includes(".."),
    );
    const k2 = buildStorageKey({ scope: "products", filename: path.parse("watch...png").name });
    check("'watch...png' → 'watch'", name(k2) === "watch");
    const k3 = buildStorageKey({ scope: "cms", filename: "a...b....c" });
    check("inner dot runs collapse to one ('a.b.c')", name(k3) === "a.b.c");
    const k4 = buildStorageKey({ scope: "uploads", filename: "..hidden." });
    check("leading/trailing dots trimmed ('hidden')", name(k4) === "hidden");
    const k5 = buildStorageKey({ scope: "uploads", filename: "..." });
    check("all-dots name falls back to 'image'", name(k5) === "image");
    const k6 = buildStorageKey({ scope: "brands", filename: "" });
    check("empty name falls back to 'image'", name(k6) === "image");
    const k7 = buildStorageKey({
      scope: "products",
      filename: path.parse("Watch.Original.jpg").name,
    });
    check("base ending in '.original' is de-dotted", name(k7) === "watch-original");
    check(
      "…so its PUBLIC primary never looks like a kept original",
      !/\.original\.[a-z0-9]+$/i.test(variantKey(k7, "primary", "jpg")),
    );
    check("scope prefix + uuid kept", new RegExp(`^products/${UUID}-rolex$`).test(k1));
    check(
      "unsafe chars still become '-'",
      name(buildStorageKey({ scope: "cms", filename: "É t/é" })) === "--t--",
    );
  }

  console.log(`\nmedia-storage-keys: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
