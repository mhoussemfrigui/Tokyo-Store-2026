/**
 * Reprocess détourage core — the eligibility guard + the `-nobg` variant
 * builder shared by the in-app job and the offline script. Pure (sharp only,
 * no DB / S3). Synthetic images generated in-memory.
 *
 * Guards the behaviours the audit flagged: GIF / url_override rows are skipped
 * (data-loss + wasted-work), encoder flags are honoured (no AVIF when the admin
 * disabled it), and the old kept-original is queued for deletion (no leak).
 * Plus the source rules (`reprocess-source`): an already-transparent image is
 * detected (skipped, not degraded), the kept original is located, normalised to
 * the upload caps and re-keyed where the repointed row still derives it.
 *
 * Run:
 *   pnpm exec tsx --conditions=react-server src/lib/db/tests/reprocess-detourage.test.ts
 */
import sharp from "sharp";

import {
  buildReprocessedDetourage,
  isReprocessIneligible,
  type ReprocessEncodeSettings,
} from "@/modules/media/reprocess-detourage";
import {
  hasTransparency,
  isMissingObjectError,
  keptOriginalKey,
  prepareOriginalSource,
  rekeyedOriginalKey,
  transparencyProbeKey,
} from "@/modules/media/reprocess-source";
import { variantStorageKeys } from "@/modules/media/storage";

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

async function makePng(
  w: number,
  h: number,
  rgb: (x: number, y: number) => [number, number, number],
): Promise<Buffer> {
  const data = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const [r, g, b] = rgb(x, y);
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

const WHITE: [number, number, number] = [255, 255, 255];
const RED: [number, number, number] = [220, 30, 30];

const ALL_ON: ReprocessEncodeSettings = {
  jpegQuality: 85,
  webpQuality: 82,
  avifQuality: 60,
  generateWebp: true,
  generateAvif: true,
};

const baseRow = {
  storage_key: "products/x.jpg",
  mime_type: "image/jpeg",
  url_override: null,
  original_url: null,
  filename: "watch.png",
};

async function main() {
  console.log("isReprocessIneligible:");
  check("GIF → 'gif'", isReprocessIneligible({ ...baseRow, mime_type: "image/gif" }) === "gif");
  check(
    "url_override set → 'override'",
    isReprocessIneligible({ ...baseRow, url_override: "https://cdn.example/x.jpg" }) === "override",
  );
  check("plain product image → false", isReprocessIneligible(baseRow) === false);
  check("empty-string override → false", isReprocessIneligible({ ...baseRow, url_override: "" }) === false);
  check(
    "whitespace-only override → false",
    isReprocessIneligible({ ...baseRow, url_override: "   " }) === false,
  );

  console.log("buildReprocessedDetourage — white sweep around a red square (all flags on):");
  {
    const img = await makePng(80, 80, (x, y) =>
      x >= 24 && x < 56 && y >= 24 && y < 56 ? RED : WHITE,
    );
    const built = await buildReprocessedDetourage(
      { ...baseRow, original_url: "/cdn/products/x.original.png" },
      img,
      ALL_ON,
    );
    check("returns a result (sweep detected)", built !== null);
    if (built) {
      check("primary key is `-nobg.jpg`", built.primaryKey === "products/x-nobg.jpg");
      check("webp key is `-nobg.webp`", built.webpKey === "products/x-nobg.webp");
      check("avif key is `-nobg.avif`", built.avifKey === "products/x-nobg.avif");
      check("jpeg buffer present", Buffer.isBuffer(built.jpeg) && built.jpeg.length > 0);
      check("webp buffer present", Buffer.isBuffer(built.webp) && (built.webp?.length ?? 0) > 0);
      check("avif buffer present", Buffer.isBuffer(built.avif) && (built.avif?.length ?? 0) > 0);
      check(
        "old primary + webp + avif queued for deletion",
        built.oldKeysToDelete.includes("products/x.jpg") &&
          built.oldKeysToDelete.includes("products/x.webp") &&
          built.oldKeysToDelete.includes("products/x.avif"),
      );
      check(
        "old kept-original queued for deletion (no leak)",
        built.oldKeysToDelete.includes("products/x.original.png"),
      );
      check("filename re-keyed to .jpg", built.newFilename === "watch.jpg");
    }
  }

  console.log("buildReprocessedDetourage — encoder flags honoured:");
  {
    const img = await makePng(80, 80, (x, y) =>
      x >= 24 && x < 56 && y >= 24 && y < 56 ? RED : WHITE,
    );
    const noWebp = await buildReprocessedDetourage(baseRow, img, {
      ...ALL_ON,
      generateWebp: false,
    });
    check("generateWebp:false → webp null + webpKey null", noWebp?.webp === null && noWebp?.webpKey === null);
    check("…avif still produced", (noWebp?.avif?.length ?? 0) > 0 && noWebp?.avifKey !== null);

    const noAvif = await buildReprocessedDetourage(baseRow, img, {
      ...ALL_ON,
      generateAvif: false,
    });
    check("generateAvif:false → avif null + avifKey null", noAvif?.avif === null && noAvif?.avifKey === null);
    check("…jpeg primary always present", (noAvif?.jpeg.length ?? 0) > 0);

    // No kept original → nothing extra queued beyond the primary/webp/avif.
    check(
      "no original_url → no `.original.` key queued",
      !(noAvif?.oldKeysToDelete ?? []).some((k) => k.includes(".original.")),
    );
  }

  console.log("buildReprocessedDetourage — non-sweep image returns null:");
  {
    const solid = await makePng(60, 60, () => RED); // uniform → no real subject
    const built = await buildReprocessedDetourage(baseRow, solid, ALL_ON);
    check("solid-colour frame → null (skipped)", built === null);
  }

  // ── Source selection (reprocess-source): never degrade an already-clean
  //    image, re-cut from the kept original, and never lose that original.
  console.log("keptOriginalKey / rekeyedOriginalKey:");
  {
    const kept = keptOriginalKey({
      storage_key: "products/x.jpg",
      original_url: "/cdn/products/x.original.PNG",
    });
    check("kept original → `<base>.original.<ext>` (ext lower-cased)", kept?.key === "products/x.original.png" && kept?.ext === "png");
    check("no original_url → null", keptOriginalKey({ storage_key: "products/x.jpg", original_url: null }) === null);
    check(
      "original_url that is just the primary (GIF / fallback case) → null",
      keptOriginalKey({ storage_key: "products/x.gif", original_url: "/cdn/products/x.gif" }) === null,
    );
    const rekeyed = rekeyedOriginalKey("products/x-nobg.jpg", "png");
    check("re-keyed beside the new family → `x-nobg.original.png`", rekeyed === "products/x-nobg.original.png");
    // The repointed row must still DERIVE the re-keyed original, or a later
    // média delete would leak it.
    const derived = variantStorageKeys({
      storage_key: "products/x-nobg.jpg",
      webp_url: "/cdn/products/x-nobg.webp",
      avif_url: null,
      original_url: `/cdn/${rekeyed}`,
    });
    check("variantStorageKeys(repointed row) includes the re-keyed original", derived.includes(rekeyed));
  }

  console.log("transparencyProbeKey:");
  {
    const row = { storage_key: "products/x.jpg", webp_url: null, avif_url: null, original_url: null };
    check("webp present → probes `.webp`", transparencyProbeKey({ ...row, webp_url: "/cdn/products/x.webp" }) === "products/x.webp");
    check("only avif → probes `.avif`", transparencyProbeKey({ ...row, avif_url: "/cdn/products/x.avif" }) === "products/x.avif");
    check("no alpha-capable variant → null", transparencyProbeKey(row) === null);
  }

  console.log("hasTransparency (already détouré → skipped):");
  {
    const rgbaCutout = await sharp({
      create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 8, height: 8, channels: 4, background: { r: 220, g: 30, b: 30, alpha: 1 } },
          })
            .png()
            .toBuffer(),
          left: 6,
          top: 6,
        },
      ])
      .webp({ lossless: true })
      .toBuffer();
    check("webp with see-through pixels → true", await hasTransparency(rgbaCutout));
    const opaqueRgba = await sharp({
      create: { width: 20, height: 20, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .png()
      .toBuffer();
    check("alpha channel but fully opaque → false", !(await hasTransparency(opaqueRgba)));
    const rgb = await makePng(20, 20, () => WHITE);
    check("no alpha channel → false", !(await hasTransparency(rgb)));
  }

  console.log("prepareOriginalSource (upload pre-stage caps):");
  {
    const big = await makePng(300, 200, (x, y) => (x > 100 && x < 200 && y > 50 && y < 150 ? RED : WHITE));
    const capped = await sharp(await prepareOriginalSource(big, { maxWidth: 150, maxHeight: 150 })).metadata();
    check("fit inside the caps, aspect kept (300×200 → 150×100)", capped.width === 150 && capped.height === 100);
    const uncapped = await sharp(await prepareOriginalSource(big, { maxWidth: 0, maxHeight: 0 })).metadata();
    check("0 caps → untouched size", uncapped.width === 300 && uncapped.height === 200);
    const small = await sharp(await prepareOriginalSource(big, { maxWidth: 4000, maxHeight: 4000 })).metadata();
    check("never enlarges", small.width === 300 && small.height === 200);
    check("lossless PNG intermediate", small.format === "png");
  }

  console.log("isMissingObjectError:");
  check("NoSuchKey name → true", isMissingObjectError({ name: "NoSuchKey" }));
  check("HTTP 404 metadata → true", isMissingObjectError({ $metadata: { httpStatusCode: 404 } }));
  check("transient error → false (the original is never dropped)", !isMissingObjectError(new Error("socket hang up")));
  check("null → false", !isMissingObjectError(null));

  console.log(`\nreprocess-detourage: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
