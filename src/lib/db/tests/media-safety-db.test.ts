import "server-only";

/**
 * Médiathèque safety — the DB-backed half of media-safety.test.ts (A–Z audit
 * 2026-09-23, P2 « media safety »).
 *
 *   1. Order-snapshot guard — `listOrderReferencedStorageKeys` returns exactly
 *      the bucket keys an order line still displays (order_items snapshot the
 *      resolved `/cdn/<key>` URL — or `<cdn base>/<key>` — never a media id), so
 *      the purge paths (cleanup-media-storage, détourage reaping) keep them and
 *      historical order thumbnails don't break.
 *   2. Processor kept original — with keep_original + strip_exif ON the stored
 *      original carries no EXIF/device data; with strip_exif OFF it stays the
 *      verbatim upload (the admin's explicit choice); a GIF stays verbatim
 *      (animation). An over-cap image throws ImageTooLargeError.
 *   3. /cdn proxy — an anonymous request for a kept `.original.` key is a 404
 *      (never cached); an ordinary key is not blocked by that guard.
 *
 * Self-cleaning (`ZZTEST-MSD-` order numbers; the media_settings singleton is
 * snapshotted and restored).
 *
 * Run (isolated DB only):
 *   DATABASE_URL=… BETTER_AUTH_SECRET=… pnpm exec tsx --conditions=react-server \
 *     --env-file-if-exists=.env.local src/lib/db/tests/media-safety-db.test.ts
 */
import { randomUUID } from "node:crypto";

import { like } from "drizzle-orm";
import { NextRequest } from "next/server";
import sharp from "sharp";

import { GET as cdnGet, HEAD as cdnHead } from "@/app/cdn/[...path]/route";
import { db } from "@/lib/db/client";
import { isImageTooLargeError, isUnsupportedImageFormatError } from "@/modules/media/image-safety";
import { processImage } from "@/modules/media/processor";
import { listOrderReferencedStorageKeys } from "@/modules/media/queries";
import { runScheduledProductDetourage } from "@/workflows/media/reprocess-product-white-bg";
import { mediaSettingsService } from "@/modules/media/settings.service";
import { order_items, orders } from "@/modules/order/schema";

const TAG = "ZZTEST-MSD-";
const SECRET_MAKE = "ZzSecretCamMake";

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

async function cleanup() {
  // order_items cascade with their order.
  await db.delete(orders).where(like(orders.order_number, `${TAG}%`));
}

async function insertOrderWithImages(
  lines: Array<{ product: string | null; variant: string | null }>,
): Promise<void> {
  const [o] = await db
    .insert(orders)
    .values({
      order_number: `${TAG}${randomUUID().slice(0, 8)}`,
      contact_email: "zztest-msd@example.test",
      subtotal_cents: 0,
      total_cents: 0,
      ship_full_name: "ZZ Test",
      ship_street_line1: "1 rue du Test",
      ship_city: "Tunis",
    })
    .returning({ id: orders.id });
  await db.insert(order_items).values(
    lines.map((l, i) => ({
      order_id: o.id,
      product_id: randomUUID(),
      product_name: `zztest line ${i}`,
      product_slug: `zztest-line-${i}`,
      product_image_url: l.product,
      variant_image_url: l.variant,
      unit_price_cents: 0,
      quantity: 1,
      subtotal_cents: 0,
    })),
  );
}

async function exifJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 64, height: 48, channels: 3, background: { r: 30, g: 140, b: 200 } },
  })
    .withExif({
      IFD0: { Make: SECRET_MAKE, Model: "ZzModelX1" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "36/1 48/1 0/1" },
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function main() {
  await cleanup();

  // ── 1. order-snapshot guard
  console.log("listOrderReferencedStorageKeys:");
  const u1 = randomUUID();
  const u2 = randomUUID();
  const u3 = randomUUID();
  const keyA = `products/${u1}-zztest-a.webp`; // same-origin /cdn snapshot
  const keyB = `products/${u2}-zztest-b.webp`; // CDN-base snapshot
  const keyU = `products/${u3}-zz_test.webp`; // `_` must not act as a wildcard
  await insertOrderWithImages([
    { product: `/cdn/${keyA}`, variant: `https://cdn.example.test/${keyB}` },
    { product: null, variant: null },
    { product: `/cdn/products/${u3}-zzxtest.webp`, variant: "" },
  ]);
  {
    const pinned = await listOrderReferencedStorageKeys([
      keyA,
      `products/${u1}-zztest-a.jpg`, // same base, other variant — not displayed
      `products/${u1}-zztest-a.avif`,
      keyB,
      `cms/${u1}-zztest-a.webp`, // same tail, other prefix
      keyU,
      `products/${randomUUID()}-zztest-c.webp`,
    ]);
    check("/cdn/<key> product snapshot → pinned", pinned.has(keyA));
    check("<cdn base>/<key> variant snapshot → pinned", pinned.has(keyB));
    check("sibling variants of a pinned base are NOT pinned", !pinned.has(`products/${u1}-zztest-a.jpg`) && !pinned.has(`products/${u1}-zztest-a.avif`));
    check("same filename under another prefix NOT pinned", !pinned.has(`cms/${u1}-zztest-a.webp`));
    check("LIKE metachar in key is literal (no false match)", !pinned.has(keyU));
    check("exactly the two displayed keys", pinned.size === 2);
    check("empty input → empty set", (await listOrderReferencedStorageKeys([])).size === 0);
    const dup = await listOrderReferencedStorageKeys([keyA, keyA, ""]);
    check("duplicates / blanks tolerated", dup.size === 1 && dup.has(keyA));
  }

  // ── 2. processor kept original
  console.log("processImage — kept original vs strip_exif:");
  const before = await mediaSettingsService.get();
  const snapshot = {
    keep_original: before.keep_original,
    strip_exif: before.strip_exif,
    product_white_bg: before.product_white_bg,
    product_white_bg_main_only: before.product_white_bg_main_only,
    generate_avif: before.generate_avif,
    generate_webp: before.generate_webp,
  };
  try {
    await mediaSettingsService.update({
      keep_original: true,
      strip_exif: true,
      product_white_bg: false,
      generate_avif: false,
      generate_webp: true,
    });
    const src = await exifJpeg();
    const p1 = await processImage(src, "image/jpeg", { scope: "uploads" });
    check("original kept", Boolean(p1.original) && p1.original !== p1.primary);
    if (p1.original) {
      const m = await sharp(p1.original.data).metadata();
      check("strip_exif ON → original has no EXIF block", !m.exif);
      check("strip_exif ON → no device string in original bytes", !p1.original.data.includes(Buffer.from(SECRET_MAKE)));
      check("original is not the raw upload", !p1.original.data.equals(src));
      check("original mime/ext follow the bytes (jpeg)", p1.original.mimeType === "image/jpeg" && p1.original.ext === "jpg" && m.format === "jpeg");
      check("sizeBytes matches the stored bytes", p1.original.sizeBytes === p1.original.data.length);
    }
    check("primary JPEG has no EXIF either", !(await sharp(p1.primary.data).metadata()).exif);

    await mediaSettingsService.update({ strip_exif: false });
    const p2 = await processImage(src, "image/jpeg", { scope: "uploads" });
    check("strip_exif OFF → original is the verbatim upload (admin's choice)", Boolean(p2.original?.data.equals(src)));

    await mediaSettingsService.update({ strip_exif: true });
    const gif = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 0, b: 0 } },
    })
      .gif()
      .toBuffer();
    const p3 = await processImage(gif, "image/gif", { scope: "uploads" });
    check("GIF stays verbatim even with strip_exif ON (animation)", Boolean(p3.original?.data.equals(gif)) && p3.primary === p3.original);

    const bomb = await sharp({
      create: { width: 9000, height: 7000, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();
    let err: unknown = null;
    try {
      await processImage(bomb, "image/png", { scope: "products" });
    } catch (e) {
      err = e;
    }
    check("over-cap image → ImageTooLargeError", isImageTooLargeError(err));
    check(
      "…with the French operator message",
      err instanceof Error && err.message.startsWith("Image trop grande (dimensions)"),
    );

    // Decoded-format re-validation: SVG bytes wearing an accepted content-type
    // (image/png) pass the declared-MIME gate but must be rejected on the real
    // format sharp decodes — so mislabeled non-raster never reaches the rasterizer.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#f00"/></svg>',
    );
    let svgErr: unknown = null;
    try {
      await processImage(svg, "image/png", { scope: "uploads" });
    } catch (e) {
      svgErr = e;
    }
    check("mislabeled SVG (declared image/png) → UnsupportedImageFormatError", isUnsupportedImageFormatError(svgErr));
    check(
      "…with the « format non supporté » operator message",
      svgErr instanceof Error && svgErr.message.startsWith("Format non supporté"),
    );

    // A GENUINE AVIF must still process. sharp decodes AVIF as format "heif" /
    // compression "av1" (NOT "avif"), so a naive decoded-format allow-list rejects
    // every real AVIF upload — this guards that regression (isAcceptedDecodedFormat).
    await mediaSettingsService.update({ generate_webp: true, generate_avif: true, product_white_bg: false });
    const realAvif = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 20, g: 130, b: 200 } } })
      .avif()
      .toBuffer();
    let avifOk = false;
    let avifPrimary = "";
    try {
      const pv = await processImage(realAvif, "image/avif", { scope: "uploads" });
      avifOk = Boolean(pv.primary) && Boolean(pv.webp);
      avifPrimary = pv.primary.mimeType;
    } catch {
      avifOk = false;
    }
    check("a genuine AVIF upload processes (not rejected as unsupported)", avifOk);
    check("…and its primary is the quality JPEG fallback", avifPrimary === "image/jpeg");

    // main-only gate: a uniform-backdrop product image is détoured at UPLOAD when
    // product_white_bg is on, UNLESS product_white_bg_main_only is on (then the
    // upload is left intact — the main image is détoured later, at product save).
    const redSquare = await sharp({ create: { width: 30, height: 24, channels: 3, background: { r: 210, g: 30, b: 30 } } })
      .png()
      .toBuffer();
    const packshot = await sharp({ create: { width: 80, height: 60, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite([{ input: redSquare, left: 25, top: 18 }])
      .png()
      .toBuffer();
    const alphaOfWebp = async (buf: Buffer, x: number, y: number): Promise<number> => {
      const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      return data[(y * info.width + x) * info.channels + 3];
    };
    await mediaSettingsService.update({
      product_white_bg: true,
      product_white_bg_main_only: false,
      generate_webp: true,
      generate_avif: false,
      keep_original: false,
      strip_exif: true,
    });
    const pAll = await processImage(packshot, "image/png", { scope: "products" });
    check("main_only OFF → upload détourage removes bg (webp corner transparent)", Boolean(pAll.webp) && (await alphaOfWebp(pAll.webp!.data, 1, 1)) === 0);

    await mediaSettingsService.update({ product_white_bg_main_only: true });
    const pMain = await processImage(packshot, "image/png", { scope: "products" });
    check("main_only ON → upload détourage SKIPPED (webp corner opaque)", Boolean(pMain.webp) && (await alphaOfWebp(pMain.webp!.data, 1, 1)) === 255);

    // Scheduled détourage (cron/run-now) respects the feature flag: when
    // product_white_bg is OFF it must be a no-op `skipped`, never removing a
    // backdrop the admin turned the feature off for.
    await mediaSettingsService.update({ product_white_bg: false });
    const sched = await runScheduledProductDetourage();
    check("scheduled détourage skipped when the feature is disabled", sched.status === "skipped" && sched.changed === 0);
  } finally {
    await mediaSettingsService.update(snapshot);
  }

  // ── 3. /cdn kept-original guard
  console.log("/cdn — kept originals are staff-only:");
  {
    const path = ["products", `${randomUUID()}-watch.original.png`];
    const req = new NextRequest(`http://localhost/cdn/${path.join("/")}`);
    const res = await cdnGet(req, { params: Promise.resolve({ path }) });
    check("anonymous GET .original. → 404", res.status === 404);
    check("…and the 404 is never cached", res.headers.get("cache-control") === "no-store");
    const head = await cdnHead(req, { params: Promise.resolve({ path }) });
    check("anonymous HEAD .original. → 404", head.status === 404);

    const pubPath = ["products", `${randomUUID()}-watch.original-look.webp`];
    const pub = await cdnGet(new NextRequest(`http://localhost/cdn/${pubPath.join("/")}`), {
      params: Promise.resolve({ path: pubPath }),
    });
    check(
      "an ordinary key is not caught by the guard",
      !(pub.status === 404 && pub.headers.get("cache-control") === "no-store"),
    );
  }

  await cleanup();
  console.log(`\n=== done: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

// On Windows, calling process.exit() while sharp/libvips is still tearing down
// its worker handles aborts Node with a libuv assertion
// (`!(handle->flags & UV_HANDLE_CLOSING)`, exit 127) — which would stop the
// whole test:db chain. Drop sharp's cache and give the handles a moment to
// close before exiting (the pg pool still needs the explicit exit).
function exitAfterSharpTeardown(code: number): void {
  sharp.cache(false);
  setTimeout(() => process.exit(code), 250);
}

main().then(
  () => exitAfterSharpTeardown(0),
  async (err) => {
    console.error(err);
    try {
      await cleanup();
    } catch {
      /* best-effort */
    }
    exitAfterSharpTeardown(1);
  },
);
