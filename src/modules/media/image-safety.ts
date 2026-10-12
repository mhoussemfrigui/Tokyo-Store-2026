import sharp from "sharp";

/**
 * Decode-safety + privacy helpers shared by EVERY sharp call in the media
 * pipeline — the upload processor, the détourage heuristic (`./white-bg`), the
 * re-process job (`./reprocess-detourage`) and, through those, the offline tsx
 * script. Pure (sharp only — no `server-only`, no DB/S3) for that reason, and so
 * the invariants are unit-testable DB-free (media-safety.test.ts).
 *
 * Decode limit
 * ────────────
 * sharp's default `limitInputPixels` is 268 MP. The only other guard on the
 * upload / URL-import / feed-import paths is the BYTE cap (8 MB by default), and
 * a highly compressible PNG of ~16k×16k fits under it — a decompression bomb that
 * makes the small shared host burn CPU and up to ~1 GB of RGBA per image (four in
 * parallel per import chunk). {@link MAX_INPUT_PIXELS} caps the decode at ~50 MP:
 * a full-frame 8000×6000 (48 MP) camera shot still passes. sharp enforces it on
 * `metadata()` too, so the processor fails fast on the header read.
 */

/** Largest decoded image accepted anywhere in the media pipeline (~50 MP). */
export const MAX_INPUT_PIXELS = 50_000_000;

/** Spread into every `sharp(input, …)` constructor that decodes image bytes. */
export const SHARP_DECODE_LIMITS = { limitInputPixels: MAX_INPUT_PIXELS } as const;

/**
 * Thrown by the processor when an image exceeds {@link MAX_INPUT_PIXELS}. The
 * message is the French operator-facing text the upload workflow surfaces
 * verbatim (instead of the generic "Impossible de traiter l'image.").
 */
export class ImageTooLargeError extends Error {
  readonly code = "image_too_large";
  constructor() {
    super(
      `Image trop grande (dimensions) : ${Math.round(MAX_INPUT_PIXELS / 1_000_000)} mégapixels maximum.`,
    );
    this.name = "ImageTooLargeError";
  }
}

/** Is this sharp's "Input image exceeds pixel limit" failure? */
export function isPixelLimitError(err: unknown): boolean {
  return err instanceof Error && /exceeds pixel limit/i.test(err.message);
}

/**
 * Decoded formats the pipeline will process — the raster set behind
 * `ACCEPTED_MIME`. The accept-gate checks the CALLER-DECLARED mime, which a
 * mislabeled upload controls (SVG/TIFF/HEIF bytes sent as `image/png` sail
 * through). sharp can decode those, so we RE-CHECK the real format sharp
 * reports and reject anything outside this set — closing the "mislabeled SVG
 * reaches librsvg" gap so the declared mime is never the final arbiter.
 */
export const ACCEPTED_DECODED_FORMATS: ReadonlySet<string> = new Set([
  "jpeg",
  "png",
  "webp",
  "avif",
  "gif",
]);

/**
 * Whether the DECODED sharp metadata is a format we accept. This is NOT a bare
 * `ACCEPTED_DECODED_FORMATS.has(format)` because of a sharp quirk: a genuine AVIF
 * decodes as `format: "heif"` with `compression: "av1"` (libheif shares the HEIF
 * container), NOT "avif" — so a plain set-check rejects every real AVIF upload.
 * We accept heif+av1 (AVIF) while still rejecting heif+hevc (true HEIC/HEVC,
 * deliberately excluded from ACCEPTED_MIME). The "avif" set entry is kept for
 * forward-compat with a sharp build that reports the format directly.
 */
export function isAcceptedDecodedFormat(meta: { format?: string; compression?: string }): boolean {
  if (meta.format && ACCEPTED_DECODED_FORMATS.has(meta.format)) return true;
  return meta.format === "heif" && meta.compression === "av1";
}

/**
 * Thrown by the processor when the DECODED format (sharp `metadata().format`)
 * isn't in {@link ACCEPTED_DECODED_FORMATS} — e.g. SVG/TIFF/HEIF bytes wearing
 * an accepted content-type. The message is the operator-facing French text the
 * upload workflow surfaces verbatim.
 */
export class UnsupportedImageFormatError extends Error {
  readonly code = "invalid_type";
  constructor(readonly detectedFormat: string) {
    super("Format non supporté. Utilisez JPG, PNG, WebP, AVIF ou GIF.");
    this.name = "UnsupportedImageFormatError";
  }
}

/** Name-based (survives duplicated module instances — HMR / test harness). */
export function isUnsupportedImageFormatError(err: unknown): err is UnsupportedImageFormatError {
  return err instanceof Error && err.name === "UnsupportedImageFormatError";
}

/**
 * Name-based (not `instanceof`) so it still matches across duplicated module
 * instances (HMR, test harness).
 */
export function isImageTooLargeError(err: unknown): err is ImageTooLargeError {
  return err instanceof Error && err.name === "ImageTooLargeError";
}

/**
 * Privacy-safe kept original
 * ──────────────────────────
 * With `keep_original` on, the source used to be stored VERBATIM at
 * `<base>.original.<ext>` — a sibling of the public primary key — so its full
 * EXIF (GPS position, device serial, timestamps of staff phone shots) stayed
 * downloadable even with `strip_exif` on. When `strip_exif` is on, the processor
 * stores THIS re-encode instead: orientation baked into the pixels (`rotate()`,
 * since the EXIF orientation tag goes away) and EVERY metadata block dropped —
 * EXIF/XMP/IPTC and the ICC profile, which can name the capture device — via
 * sharp's default (no `keepMetadata()`), which also converts to sRGB exactly
 * like the stored webp/avif/jpeg variants. Encoded at maximum fidelity in the
 * source's own family so it still serves the "re-encode later at a higher
 * quality" purpose:
 *   - JPEG → JPEG q100 with 4:4:4 chroma (no extra subsampling loss);
 *   - WebP → lossless WebP;
 *   - anything else (PNG, AVIF/HEIF…) → lossless PNG.
 * The returned mime/ext describe the bytes actually produced, so the stored
 * `original_mime_type` and the `.original.<ext>` key stay truthful.
 */
export type StrippedOriginal = {
  data: Buffer;
  width: number;
  height: number;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  ext: "jpg" | "png" | "webp";
};

export async function encodeStrippedOriginal(
  input: Buffer,
  sourceFormat: string | undefined,
): Promise<StrippedOriginal> {
  const pipeline = sharp(input, { failOn: "error", ...SHARP_DECODE_LIMITS }).rotate();
  let mimeType: StrippedOriginal["mimeType"];
  let ext: StrippedOriginal["ext"];
  if (sourceFormat === "jpeg") {
    pipeline.jpeg({ quality: 100, chromaSubsampling: "4:4:4" });
    mimeType = "image/jpeg";
    ext = "jpg";
  } else if (sourceFormat === "webp") {
    pipeline.webp({ lossless: true });
    mimeType = "image/webp";
    ext = "webp";
  } else {
    pipeline.png();
    mimeType = "image/png";
    ext = "png";
  }
  const out = await pipeline.toBuffer({ resolveWithObject: true });
  return { data: out.data, width: out.info.width, height: out.info.height, mimeType, ext };
}
