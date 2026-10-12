import sharp from "sharp";

import { SHARP_DECODE_LIMITS } from "./image-safety";

/**
 * Source selection for the détourage RE-PROCESS of existing product packshots —
 * shared by the in-app job (src/workflows/media/reprocess-product-white-bg.ts)
 * and the offline script (scripts/reprocess-product-white-bg.ts), next to the
 * image transform in `./reprocess-detourage`. Pure besides `sharp` +
 * `./image-safety` (no `server-only`, no DB/S3) so the tsx script can import it
 * and the decision helpers are unit-testable DB-free.
 *
 * Three rules keep the reprocess from degrading or destroying good images:
 *
 *   1. Already transparent → skip. An image cut out AT UPLOAD (the
 *      `product_white_bg` toggle) or a transparent PNG packshot keeps a normal
 *      (non-`-nobg`) key, so the scan still picks it up — but its alpha-capable
 *      variant (WebP / AVIF) already has see-through pixels. Re-flooding its
 *      white-FLATTENED JPEG primary would only produce a second-generation copy
 *      with a white halo in the feathered edge.
 *   2. Kept original → use it as the source. The q-jpeg primary is lossy and,
 *      for a transparent source, flattened; the original (kept by
 *      `keep_original` precisely "to re-process later") is the faithful input.
 *      It is normalised like the upload pre-stage (EXIF auto-rotate + the
 *      max-width/height caps) so the re-cut matches a fresh upload's size.
 *   3. Kept original → never lost. It is re-keyed beside the new `-nobg`
 *      family (`<base>-nobg.original.<ext>`) so `variantStorageKeys()` of the
 *      repointed row still derives — and a later média delete still reaps — it.
 */

/** The media-row fields the source planning reads. */
export type ReprocessSourceRow = {
  storage_key: string;
  webp_url: string | null;
  avif_url: string | null;
  original_url: string | null;
};

const stripExt = (key: string) => key.replace(/\.[^./]+$/, "");

/**
 * Bucket key + extension of the row's kept ORIGINAL — stored at
 * `<base>.original.<ext>` (see `variantKey`) — or null when none is kept (or
 * when `original_url` is just the primary itself, the GIF / no-variant case).
 */
export function keptOriginalKey(
  row: Pick<ReprocessSourceRow, "storage_key" | "original_url">,
): { key: string; ext: string } | null {
  const m = row.original_url?.match(/\.original\.([a-z0-9]+)(?:\?|$)/i);
  if (!m?.[1]) return null;
  const ext = m[1].toLowerCase();
  return { key: `${stripExt(row.storage_key)}.original.${ext}`, ext };
}

/** Where the kept original lives once the row points at the new `-nobg` primary. */
export function rekeyedOriginalKey(newPrimaryKey: string, ext: string): string {
  return `${stripExt(newPrimaryKey)}.original.${ext}`;
}

/** Key of an alpha-capable variant to probe for existing transparency (WebP
 *  first, then AVIF), or null when the row has neither. */
export function transparencyProbeKey(row: ReprocessSourceRow): string | null {
  const base = stripExt(row.storage_key);
  if (row.webp_url) return `${base}.webp`;
  if (row.avif_url) return `${base}.avif`;
  return null;
}

/** True when the image carries an alpha channel with at least one pixel that
 *  isn't fully opaque — i.e. its backdrop is already see-through. */
export async function hasTransparency(bytes: Buffer): Promise<boolean> {
  const img = sharp(bytes, SHARP_DECODE_LIMITS);
  const meta = await img.metadata();
  if (!meta.hasAlpha) return false;
  const stats = await img.stats();
  const alpha = stats.channels[stats.channels.length - 1];
  return alpha !== undefined && alpha.min < 255;
}

/**
 * Normalise kept-original bytes like the upload pipeline's pre-stage
 * (processor.ts): EXIF auto-rotate, then the two independent axis caps
 * (`fit: "inside"`, never enlarging; 0 = no cap on that axis). Emits lossless
 * PNG so the flood-fill runs on undegraded pixels.
 */
export async function prepareOriginalSource(
  bytes: Buffer,
  caps: { maxWidth: number; maxHeight: number },
): Promise<Buffer> {
  let pipeline = sharp(bytes, { failOn: "error", ...SHARP_DECODE_LIMITS }).rotate();
  const capW = caps.maxWidth > 0 ? caps.maxWidth : undefined;
  const capH = caps.maxHeight > 0 ? caps.maxHeight : undefined;
  if (capW || capH) {
    pipeline = pipeline.resize({ width: capW, height: capH, fit: "inside", withoutEnlargement: true });
  }
  return pipeline.png().toBuffer();
}

/** An S3 "object does not exist" error (vs a transient failure). */
export function isMissingObjectError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === "NoSuchKey" || e.Code === "NoSuchKey" || e.$metadata?.httpStatusCode === 404;
}
