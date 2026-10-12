import "server-only";

import sharp from "sharp";

import {
  encodeStrippedOriginal,
  ImageTooLargeError,
  isAcceptedDecodedFormat,
  isPixelLimitError,
  SHARP_DECODE_LIMITS,
  UnsupportedImageFormatError,
} from "./image-safety";
import { MAX_UPLOAD_BYTES_FALLBACK } from "./limits";
import { mediaSettingsService } from "./settings.service";
import { removeUniformBackground } from "./white-bg";

/**
 * Image processing — runs once at upload time.
 *
 *   - normalises orientation (mobile uploads are often rotated)
 *   - optionally strips EXIF (privacy / size)
 *   - emits up to four variants: a quality-controlled JPEG (the universal
 *     fallback, also the canonical `url`), WebP, AVIF, and the optional kept
 *     original (verbatim passthrough, or a metadata-free max-fidelity re-encode
 *     when `strip_exif` is on — see `encodeStrippedOriginal`).
 *   - refuses decompression bombs: every decode is capped at MAX_INPUT_PIXELS
 *     (~50 MP) → `ImageTooLargeError` ("Image trop grande (dimensions)").
 *
 * Which variants are emitted is driven entirely by `media_settings` so an
 * admin can flip AVIF generation on/off without a deploy. The encoder qualities
 * (webp/avif/JPEG) and the resize cap are equally live-tunable.
 *
 * The JPEG fallback
 * ─────────────────
 * `jpeg_quality` re-encodes a baseline JPEG via `sharp.jpeg({ quality })`.
 * It becomes the canonical row `url` so clients that can't render webp/avif
 * (raw `<img>`, some social scrapers / mail clients) still get a sensible,
 * quality-controlled image — the url-resolver reaches it after webp/avif.
 * Animated GIFs are exempt (sharp would drop their animation): they fall back
 * to their original instead.
 *
 * Why we sometimes keep the original
 * ─────────────────────────────────
 * AVIF/WebP are smaller and good enough for 99% of consumers, but:
 *   - If we ever need to re-encode at a higher quality, we need the source.
 *   - Some legacy browsers / partner integrations want JPG/PNG.
 *   - GIFs lose their animation under sharp, so we never generate webp/avif for
 *     them; the original (or the raw-input fallback) preserves the animation.
 *
 * The admin enables "keep_original" only when storage cost is acceptable.
 */

export type ProcessedVariant = {
  data: Buffer;
  width: number;
  height: number;
  mimeType: "image/webp" | "image/avif" | "image/jpeg" | "image/png" | "image/gif";
  sizeBytes: number;
  ext: string;
};

export type ProcessedImage = {
  /**
   * Canonical variant → the row `url`. The quality-controlled JPEG when one was
   * generated (the universal fallback the url-resolver serves to clients that
   * can't render webp/avif — raw `<img>`, social scrapers, mail clients);
   * for GIFs (no JPEG — sharp would flatten the animation) it's the kept
   * original, or the raw-input fallback when keep_original is off.
   */
  primary: ProcessedVariant;
  webp?: ProcessedVariant;
  avif?: ProcessedVariant;
  original?: ProcessedVariant;
  width: number;
  height: number;
};

/** Acceptable input MIMEs. Anything else short-circuits. */
const ACCEPTED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
]);

export function isAcceptedImageMime(mime: string): boolean {
  return ACCEPTED_MIME.has(mime);
}

/**
 * Max upload bytes is settings-driven; this fallback is for callers that
 * need a synchronous answer before the DB connects (e.g. early Next.js
 * request guards). Defined in `./limits` (framework-free) so the same value
 * is shared with the client admin panel and the schema default — re-exported
 * here to preserve the module's public surface.
 */
export { MAX_UPLOAD_BYTES_FALLBACK };

export async function getMaxUploadBytes(): Promise<number> {
  const s = await mediaSettingsService.get();
  // Settings row is seeded with a non-null default, but guard a wiped/garbled
  // value so the upload size check never compares against NaN/0 — falling back
  // to the shared default ceiling instead.
  const mb = s.max_upload_mb;
  if (!Number.isFinite(mb) || mb <= 0) return MAX_UPLOAD_BYTES_FALLBACK;
  return mb * 1024 * 1024;
}

/**
 * Run the configured pipeline against an in-memory buffer. The returned
 * object always contains at least one `primary` variant — the storefront's
 * canonical URL. WebP/AVIF/original are populated when their flags are on.
 *
 * The choice of which variant is "primary" follows the storefront preference
 * order: AVIF (best compression) > WebP (broad support) > original. This is
 * deterministic so an admin disabling AVIF mid-flight doesn't break URL
 * resolution for already-uploaded media.
 */
/**
 * Per-call context the pipeline can branch on. Optional + back-compatible:
 * existing callers that pass only `(buffer, mime)` keep their behaviour.
 *
 *   - `scope` — the upload destination ("products", "categories", …). Only
 *     "products" is eligible for the auto white-background flatten, so a CMS /
 *     brand logo with intentional transparency is never altered.
 */
export type ProcessImageOptions = {
  scope?: "products" | "categories" | "brands" | "cms" | "uploads";
};

export async function processImage(
  input: Buffer,
  inputMime: string,
  options: ProcessImageOptions = {},
): Promise<ProcessedImage> {
  const settings = await mediaSettingsService.get();

  // Common pre-stage: auto-rotate, optionally strip EXIF, optionally resize.
  // SHARP_DECODE_LIMITS caps the decode at ~50 MP (sharp's default is 268 MP):
  // feed / URL imports hand us third-party bytes, and a compressible PNG bomb
  // fits under the byte cap. sharp enforces the limit on the header read below,
  // so an oversized image fails fast — mapped to a clear operator error.
  let pipeline = sharp(input, { failOn: "error", ...SHARP_DECODE_LIMITS }).rotate();

  let meta: sharp.Metadata;
  try {
    meta = await pipeline.metadata();
  } catch (err) {
    if (isPixelLimitError(err)) throw new ImageTooLargeError();
    throw err;
  }
  if (!meta.width || !meta.height) {
    throw new Error("Unable to determine image dimensions.");
  }

  // Re-validate the DECODED format against the accepted raster set. The MIME
  // accept-gate (isAcceptedImageMime) trusts the caller-declared type, so SVG /
  // TIFF / HEIF bytes wearing an accepted content-type reach here; sharp would
  // otherwise happily rasterize them (SVG via librsvg). Reject on the real
  // format so acceptance is keyed on the bytes, not the label.
  if (!isAcceptedDecodedFormat(meta)) {
    throw new UnsupportedImageFormatError(meta.format ?? "unknown");
  }

  // Detect the REAL format from the decoded bytes, NOT the caller-declared mime
  // (which a mislabeled upload controls). Only a genuine GIF skips the
  // jpeg/webp/avif re-encode so its animation survives — bytes merely *labelled*
  // image/gif (e.g. a JPEG with a forged content-type) still get re-encoded
  // instead of being stored verbatim.
  const isGif = meta.format === "gif";

  // Independent width / height caps (0 = no cap on that axis). `fit: "inside"`
  // scales the image down so it fits within BOTH bounds while preserving the
  // aspect ratio — so `max_width_px` and `max_height_px` behave as the two
  // separate caps the settings UI presents, rather than being collapsed into a
  // single longest-edge cap. Only resize when at least one cap is exceeded.
  const capW = settings.max_width_px || 0;
  const capH = settings.max_height_px || 0;
  const exceedsW = capW > 0 && meta.width > capW;
  const exceedsH = capH > 0 && meta.height > capH;
  if (exceedsW || exceedsH) {
    pipeline = pipeline.resize({
      width: capW > 0 ? capW : undefined,
      height: capH > 0 ? capH : undefined,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  // strip_exif semantics (sharp): by DEFAULT sharp drops ALL metadata, so the
  // strip path just emits the buffer without re-attaching any. `.keepMetadata()`
  // retains EXIF/ICC/etc. when the admin opts to preserve it. (Gotcha: never
  // "strip" via `.withMetadata({})` — that call PRESERVES metadata.) The
  // `.rotate()` above already bakes orientation into pixels, so stripping never
  // leaves images sideways.
  const baseBuffer = await (settings.strip_exif
    ? pipeline.toBuffer({ resolveWithObject: true })
    : pipeline.keepMetadata().toBuffer({ resolveWithObject: true })
  );

  const width = baseBuffer.info.width;
  const height = baseBuffer.info.height;

  // Auto UNIFORM-backdrop REMOVAL for PRODUCT images (admin toggle
  // `product_white_bg` — name kept for the frozen column; the algorithm now
  // handles any flat sweep, white/black/grey/colour). When enabled, a clean
  // studio packshot on a uniform sweep has its connected backdrop flood-filled
  // to TRANSPARENT (see ./white-bg) so the watch floats on the storefront's
  // ivory/onyx cards instead of sitting in a rectangle. It preserves interior
  // regions matching the backdrop (e.g. a white dial on a white sweep) and is a
  // no-op on non-packshot photos (textured / gradient backgrounds → unchanged).
  //
  // Gated three ways so it never silently alters unrelated media:
  //   1. setting enabled, 2. scope === "products", 3. not an animated GIF.
  // The transparent result feeds the alpha-capable webp/avif variants; the JPEG
  // fallback (no alpha) is flattened back onto WHITE so non-webp/avif clients
  // still get a clean packshot. Wrapped in try/catch: removal must NEVER break
  // an upload — we log and fall through with the unaltered source.
  // The variant encoders read from EITHER the base's encoded bytes OR, when the
  // backdrop was removed, the raw RGBA détourage output (no PNG round-trip). A
  // raw source needs sharp's `{ raw: {…} }` constructor option; `srcSharp()`
  // hides that so the jpeg/webp/avif blocks stay identical either way.
  let variantSource: { data: Buffer; raw?: { width: number; height: number; channels: 4 } } = {
    data: baseBuffer.data,
  };
  const srcSharp = () =>
    sharp(
      variantSource.data,
      variantSource.raw ? { raw: variantSource.raw, ...SHARP_DECODE_LIMITS } : SHARP_DECODE_LIMITS,
    );
  let removedWhiteBg = false;
  // In MAIN-ONLY mode, upload-time détourage is skipped entirely: the product's
  // main image is détoured at product SAVE instead (a gallery upload can't yet
  // know if it will become the main image), so secondary shots keep their
  // backdrop. Otherwise every eligible product upload is détoured here.
  const wantRemoveBg =
    settings.product_white_bg &&
    !settings.product_white_bg_main_only &&
    options.scope === "products" &&
    !isGif;
  if (wantRemoveBg) {
    try {
      const res = await removeUniformBackground(baseBuffer.data);
      if (res.changed) {
        variantSource = { data: res.data, raw: { width: res.width, height: res.height, channels: 4 } };
        removedWhiteBg = true;
      }
    } catch (err) {
      console.error("[media:processor] white-bg removal failed; keeping original", err);
    }
  }

  let webp: ProcessedVariant | undefined;
  let avif: ProcessedVariant | undefined;
  let jpeg: ProcessedVariant | undefined;
  let original: ProcessedVariant | undefined;

  // Quality-controlled JPEG — the universal fallback served to clients that
  // can't handle webp/avif, and the canonical row `url`. We skip GIFs: sharp
  // would flatten the animation, and `keep_original` is the right escape hatch
  // for those (handled below). `mozjpeg: true` gives a smaller file at the
  // same visual quality; `jpeg_quality` is the live-tunable knob (clamped
  // 30-100 by the settings service).
  if (!isGif) {
    // The JPEG fallback can't carry alpha. Flatten to white whenever the source
    // has an alpha channel — not only when WE removed a bg: a transparent PNG
    // product upload (or one where removal returned changed:false) would
    // otherwise composite over sharp's DEFAULT BLACK and ship a black-rectangle
    // JPEG primary (the canonical row `url`). `flatten` is a no-op on opaque
    // images, so this is always safe.
    const jpegPipe = srcSharp();
    if (removedWhiteBg || meta.hasAlpha) jpegPipe.flatten({ background: { r: 255, g: 255, b: 255 } });
    const out = await jpegPipe
      .jpeg({ quality: settings.jpeg_quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    jpeg = {
      data: out.data,
      width: out.info.width,
      height: out.info.height,
      mimeType: "image/jpeg",
      sizeBytes: out.data.length,
      ext: "jpg",
    };
  }

  // GIFs are exempt (like the JPEG block above): sharp decodes only the first
  // frame, so a webp/avif variant would be a STATIC snapshot that then WINS the
  // resolver chain (avif→webp→url→original) over the animated original. Skipping
  // them leaves webp_url/avif_url null so the resolver serves the animated GIF.
  if (!isGif && settings.generate_webp) {
    // webp carries alpha → keeps the transparent cut-out when bg was removed.
    const out = await srcSharp()
      .webp({ quality: settings.webp_quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    webp = {
      data: out.data,
      width: out.info.width,
      height: out.info.height,
      mimeType: "image/webp",
      sizeBytes: out.data.length,
      ext: "webp",
    };
  }

  if (!isGif && settings.generate_avif) {
    // avif carries alpha → keeps the transparent cut-out when bg was removed.
    const out = await srcSharp()
      .avif({ quality: settings.avif_quality, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    avif = {
      data: out.data,
      width: out.info.width,
      height: out.info.height,
      mimeType: "image/avif",
      sizeBytes: out.data.length,
      ext: "avif",
    };
  }

  if (settings.keep_original) {
    if (settings.strip_exif && !isGif) {
      // The kept original lives at `<base>.original.<ext>`, a publicly derivable
      // sibling of the primary key — storing the raw upload would leak its full
      // EXIF (GPS, device serial, timestamps) despite strip_exif. Store a
      // metadata-free, max-fidelity re-encode instead (mime/ext follow the bytes
      // actually produced, so original_mime_type + the key stay truthful).
      const stripped = await encodeStrippedOriginal(input, meta.format);
      original = {
        data: stripped.data,
        width: stripped.width,
        height: stripped.height,
        mimeType: stripped.mimeType,
        sizeBytes: stripped.data.length,
        ext: stripped.ext,
      };
    } else {
      // strip_exif off (the admin chose to preserve metadata), or a GIF (sharp
      // would destroy the animation): pass the raw input bytes through verbatim.
      original = {
        data: input,
        width: meta.width,
        height: meta.height,
        mimeType: (inputMime as ProcessedVariant["mimeType"]) ?? "image/jpeg",
        sizeBytes: input.length,
        ext: extFromMime(inputMime) ?? "bin",
      };
    }
  }

  // Pick the canonical primary — i.e. what lands in the row `url`. This is
  // deliberately the quality-controlled JPEG (not avif/webp): the url-resolver
  // serves avif/webp first to capable clients and only falls through to `url`
  // for non-webp/avif consumers, so `url` must be the universal format. GIFs
  // have no JPEG (animation) — they fall back to their original. If somehow no
  // variant exists (e.g. a GIF with keep_original off), pass the raw input
  // through so uploads never fail silently with zero variants.
  let primary: ProcessedVariant | undefined = jpeg ?? original;
  if (!primary) {
    original = {
      data: input,
      width: meta.width,
      height: meta.height,
      mimeType: (inputMime as ProcessedVariant["mimeType"]) ?? "image/jpeg",
      sizeBytes: input.length,
      ext: extFromMime(inputMime) ?? "bin",
    };
    primary = original;
  }

  return { primary, webp, avif, original, width, height };
}

function extFromMime(mime: string): string | null {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "image/gif":
      return "gif";
    default:
      return null;
  }
}
