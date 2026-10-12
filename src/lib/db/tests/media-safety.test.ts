/**
 * Médiathèque safety invariants (A–Z audit 2026-09-23, P2 « media safety ») —
 * NO database, NO S3.
 *
 *   1. Upload scope allow-list — a Server Action can't pick an arbitrary S3 key
 *      prefix (buildStorageKey interpolates it verbatim) or dodge the
 *      products-only détourage gate.
 *   2. `url_override` validation — only a `/cdn/<key>` path or an http(s) URL on a
 *      build-time allow-listed media host (the next/image remotePatterns + CSP
 *      shape) is accepted; `javascript:`/`data:`/foreign hosts are refused.
 *   3. Privacy-safe kept original — with `strip_exif` on, the kept original is a
 *      metadata-free re-encode (no EXIF/GPS/device), orientation baked in, in the
 *      source's own family (JPEG→JPEG, WebP→WebP, else PNG).
 *   4. Decode cap — a decompression-bomb PNG (tiny bytes, huge dimensions) is
 *      refused by sharp under SHARP_DECODE_LIMITS, and maps to the French
 *      « Image trop grande (dimensions) » operator error.
 *   5. Storefront cache bust on delete — `media.deleted` (the Médiathèque single
 *      AND bulk delete, per row) and `media.bulk_deleted` expire the storefront
 *      tags (products / blog…), so cached PDPs stop pointing at purged objects.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/media-safety.test.ts
 */
import sharp from "sharp";

import { bus } from "@/events/bus";
import { registerMediaCacheSubscriber } from "@/events/subscribers/invalidate-media-cache";
import { CACHE_TAGS } from "@/lib/cache/tags";
import { ttlCached } from "@/lib/cache/ttl";
import {
  encodeStrippedOriginal,
  ImageTooLargeError,
  isImageTooLargeError,
  isPixelLimitError,
  MAX_INPUT_PIXELS,
  SHARP_DECODE_LIMITS,
} from "@/modules/media/image-safety";
import {
  checkUrlOverride,
  isMediaUploadScope,
  MEDIA_UPLOAD_SCOPES,
  parseMediaUploadScope,
} from "@/modules/media/validation";

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

const SECRET_MAKE = "ZzSecretCamMake";

/** A small solid image carrying identifying EXIF (device make/model + GPS). */
async function withExif(
  format: "jpeg" | "png" | "webp",
  opts: { width?: number; height?: number; orientation?: number } = {},
): Promise<Buffer> {
  let p = sharp({
    create: {
      width: opts.width ?? 40,
      height: opts.height ?? 20,
      channels: 3,
      background: { r: 20, g: 160, b: 90 },
    },
  })
    .withExif({
      IFD0: { Make: SECRET_MAKE, Model: "ZzModelX1" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "36/1 48/1 0/1" },
    });
  if (opts.orientation) p = p.withMetadata({ orientation: opts.orientation });
  if (format === "jpeg") p = p.jpeg({ quality: 90 });
  else if (format === "png") p = p.png();
  else p = p.webp({ quality: 90 });
  return p.toBuffer();
}

async function main() {
  // ── 1. upload scopes
  console.log("upload scope allow-list:");
  check("the five known scopes", MEDIA_UPLOAD_SCOPES.length === 5);
  for (const s of ["uploads", "products", "categories", "brands", "cms"]) {
    check(`'${s}' accepted`, isMediaUploadScope(s) && parseMediaUploadScope(s) === s);
  }
  for (const bad of ["../etc", "products/../x", "Products", "", "secret", null, undefined, 42]) {
    check(
      `${JSON.stringify(bad)} rejected → falls back to 'uploads'`,
      !isMediaUploadScope(bad) && parseMediaUploadScope(bad) === "uploads",
    );
  }

  // ── 2. url_override
  console.log("url_override validation:");
  const SOURCES = ["https://minio.example.tn/tokyo", "https://cdn.example.tn"];
  const ok = (v: string, sources: readonly string[] = SOURCES) => checkUrlOverride(v, sources) === null;
  check("empty clears (ok)", ok(""));
  check("blank clears (ok)", ok("   "));
  check("/cdn/<key> path ok", ok("/cdn/products/0190-abc-watch.webp"));
  check("/cdn/ with '..' refused", !ok("/cdn/../secret"));
  check("/cdn/ with dot-led segment refused", !ok("/cdn/.hidden/x.webp"));
  check("/cdn/ empty segment refused", !ok("/cdn/products//x.webp"));
  check("bare /cdn/ refused", !ok("/cdn/"));
  check("other same-origin path refused", !ok("/uploads/x.webp"));
  check("protocol-relative //host refused", !ok("//evil.example/x.webp"));
  check("backslash bypass refused", !ok("/\\evil.example/x.webp"));
  check("javascript: refused", !ok("javascript:alert(1)"));
  check("data: refused", !ok("data:image/png;base64,iVBORw0KGgo="));
  check("CDN host (bare origin → any path) ok", ok("https://cdn.example.tn/products/a.webp"));
  check("MinIO host under the bucket prefix ok", ok("https://minio.example.tn/tokyo/products/a.webp"));
  check("MinIO host OUTSIDE the bucket prefix refused", !ok("https://minio.example.tn/other/a.webp"));
  check("prefix look-alike (/tokyoX) refused", !ok("https://minio.example.tn/tokyoX/a.webp"));
  check("scheme mismatch (http vs https) refused", !ok("http://cdn.example.tn/a.webp"));
  check("port mismatch refused", !ok("https://cdn.example.tn:8443/a.webp"));
  check("foreign host refused", !ok("https://evil.example/a.webp"));
  check("credentials in URL refused", !ok("https://user:pw@cdn.example.tn/a.webp"));
  check("whitespace refused", !ok("https://cdn.example.tn/a b.webp"));
  check("host match is case-insensitive", ok("https://CDN.Example.TN/a.webp"));
  check("no allow-list → absolute URL refused", !ok("https://cdn.example.tn/a.webp", []));
  check("no allow-list → /cdn path still ok", ok("/cdn/x/y.webp", []));
  check("malformed allow-list entry skipped", ok("https://cdn.example.tn/a.webp", ["::nope::", ...SOURCES]));
  check("over-long value refused", !ok(`https://cdn.example.tn/${"a".repeat(2100)}`));
  check(
    "error text is French",
    /Hôte non autorisé/.test(checkUrlOverride("https://evil.example/a.webp", SOURCES) ?? ""),
  );

  // ── 3. privacy-safe kept original
  console.log("encodeStrippedOriginal — EXIF/GPS/device dropped:");
  {
    const src = await withExif("jpeg");
    const srcMeta = await sharp(src).metadata();
    check("fixture JPEG carries EXIF", Boolean(srcMeta.exif) && src.includes(Buffer.from(SECRET_MAKE)));
    const out = await encodeStrippedOriginal(src, srcMeta.format);
    const meta = await sharp(out.data).metadata();
    check("JPEG → JPEG (mime + ext)", out.mimeType === "image/jpeg" && out.ext === "jpg" && meta.format === "jpeg");
    check("no EXIF block", !meta.exif);
    check("no device string anywhere in the bytes", !out.data.includes(Buffer.from(SECRET_MAKE)));
    check("no ICC / XMP / IPTC", !meta.icc && !meta.xmp && !meta.iptc);
    check("dimensions preserved", out.width === 40 && out.height === 20);
  }
  {
    // EXIF orientation 6 (rotate 90° CW): the tag goes away, so it must be baked
    // into the pixels or the original would display sideways.
    const src = await withExif("jpeg", { width: 40, height: 20, orientation: 6 });
    const out = await encodeStrippedOriginal(src, "jpeg");
    const meta = await sharp(out.data).metadata();
    check("orientation baked in (40×20 + tag 6 → 20×40)", out.width === 20 && out.height === 40);
    check("no orientation tag left", !meta.orientation || meta.orientation === 1);
  }
  {
    const src = await withExif("png");
    const out = await encodeStrippedOriginal(src, "png");
    const meta = await sharp(out.data).metadata();
    check("PNG → lossless PNG", out.mimeType === "image/png" && out.ext === "png" && meta.format === "png");
    check("PNG: no EXIF / device string", !meta.exif && !out.data.includes(Buffer.from(SECRET_MAKE)));
  }
  {
    const src = await withExif("webp");
    const out = await encodeStrippedOriginal(src, "webp");
    const meta = await sharp(out.data).metadata();
    check("WebP → WebP", out.mimeType === "image/webp" && out.ext === "webp" && meta.format === "webp");
    check("WebP: no EXIF / device string", !meta.exif && !out.data.includes(Buffer.from(SECRET_MAKE)));
  }
  {
    const avif = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .avif({ quality: 60 })
      .toBuffer();
    const fmt = (await sharp(avif).metadata()).format;
    const out = await encodeStrippedOriginal(avif, fmt);
    check("AVIF/HEIF → lossless PNG (mime/ext follow the bytes)", out.mimeType === "image/png" && out.ext === "png");
  }

  // ── 4. decode cap
  console.log("decode cap (decompression bomb):");
  {
    const bomb = await sharp({
      create: { width: 9000, height: 7000, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();
    check("bomb is tiny on disk (< 1 MB) yet over the pixel cap", bomb.length < 1_000_000 && 9000 * 7000 > MAX_INPUT_PIXELS);
    let metaErr: unknown = null;
    try {
      await sharp(bomb, { failOn: "error", ...SHARP_DECODE_LIMITS }).rotate().metadata();
    } catch (err) {
      metaErr = err;
    }
    check("header read already refuses it (fail fast)", isPixelLimitError(metaErr));
    let stripErr: unknown = null;
    try {
      await encodeStrippedOriginal(bomb, "png");
    } catch (err) {
      stripErr = err;
    }
    check("the kept-original encoder is capped too", isPixelLimitError(stripErr));
    const ok48 = await sharp({
      create: { width: 8000, height: 6000, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const m = await sharp(ok48, SHARP_DECODE_LIMITS).metadata();
    check("a 48 MP camera-size frame still passes", m.width === 8000 && m.height === 6000);
    check("non-sharp error is not a pixel-limit error", !isPixelLimitError(new Error("boom")));
  }
  {
    const e = new ImageTooLargeError();
    check("ImageTooLargeError → French operator message", e.message.startsWith("Image trop grande (dimensions)"));
    check("isImageTooLargeError(ImageTooLargeError)", isImageTooLargeError(e));
    check("isImageTooLargeError(other) = false", !isImageTooLargeError(new Error("x")) && !isImageTooLargeError("x"));
  }

  // ── 5. cache bust on delete
  console.log("storefront cache bust on media delete:");
  {
    bus.__reset();
    registerMediaCacheSubscriber();
    let productsCalls = 0;
    let blogCalls = 0;
    const productsProbe = ttlCached(async () => ++productsCalls, {
      ttlMs: 60_000,
      tags: [CACHE_TAGS.productsList],
    });
    const blogProbe = ttlCached(async () => ++blogCalls, {
      ttlMs: 60_000,
      tags: [CACHE_TAGS.blogPosts],
    });
    await productsProbe();
    await productsProbe();
    await blogProbe();
    check("probes cached (1 compute each)", productsCalls === 1 && blogCalls === 1);

    await bus.emit("media.uploaded", { mediaId: "m0", storageKey: "k", sizeBytes: 1 });
    await productsProbe();
    check("media.uploaded does NOT bust", productsCalls === 1);

    await bus.emit("media.deleted", { mediaId: "m1", storageKey: "k1", storageKeys: ["k1"] });
    await productsProbe();
    await blogProbe();
    check("media.deleted busts the product tags", productsCalls === 2);
    check("media.deleted busts the blog listing tag", blogCalls === 2);

    await bus.emit("media.bulk_deleted", { mediaIds: ["m2"], deletedCount: 1, storageKeys: [] });
    await productsProbe();
    check("media.bulk_deleted busts", productsCalls === 3);

    await bus.emit("media.updated", { mediaId: "m3", changedFields: ["alt_text"] });
    await productsProbe();
    check("media.updated still busts", productsCalls === 4);
    bus.__reset();
  }

  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
