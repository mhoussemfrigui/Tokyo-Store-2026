import sharp from "sharp";

import { SHARP_DECODE_LIMITS } from "./image-safety";
import { removeUniformBackground } from "./white-bg";

/**
 * Shared core for the détourage RE-PROCESS of EXISTING product packshots.
 *
 * Two callers run this same transformation against already-stored product
 * images:
 *   - the in-app background job  (src/workflows/media/reprocess-product-white-bg.ts —
 *     Drizzle + the app S3 client, fired from /admin/media/settings)
 *   - the offline migration script (scripts/reprocess-product-white-bg.ts —
 *     raw `pg` + its own S3 client, for one-off catalogue backfills)
 *
 * They differ only in their DB/S3 plumbing; the IMAGE work — deciding whether a
 * row is eligible, running the flood-fill, encoding the `-nobg` variant family,
 * and listing the old objects to reap — is identical and lives HERE so the two
 * can never drift (the kind of bug where a GIF guard is fixed in one path but
 * silently missing in the other).
 *
 * Pure besides `sharp` + `./white-bg` + `./image-safety` (no `server-only`, no
 * DB/S3) so the tsx script can import it and so the decision helpers are
 * unit-testable DB-free.
 */

/** The media-row fields the reprocess transform reads. */
export type ReprocessRow = {
  storage_key: string;
  mime_type: string | null;
  url_override: string | null;
  original_url: string | null;
  filename: string | null;
};

/**
 * Encoder knobs + variant toggles, sourced from `media_settings` so a
 * reprocessed image matches what a FRESH upload would produce on this store —
 * rather than diverging on a hard-coded quality / always emitting a format the
 * admin disabled. The upload processor reads the same row (processor.ts).
 */
export type ReprocessEncodeSettings = {
  jpegQuality: number;
  webpQuality: number;
  avifQuality: number;
  generateWebp: boolean;
  generateAvif: boolean;
};

/**
 * Rows the reprocess must NOT touch, mirroring the upload-path guards:
 *
 *   - animated GIF — sharp decodes only the first frame, so a `-nobg`
 *     JPEG/WebP/AVIF family would be a STATIC snapshot that then WINS the
 *     resolver chain (avif→webp→url→original) over the animated original. The
 *     reprocess deletes the source, so the animation is unrecoverable. The
 *     upload processor exempts GIFs for exactly this reason (processor.ts:190).
 *   - url_override pinned — the storefront serves `url_override` FIRST (see
 *     url-resolver), so rewriting storage_key/url/webp/avif here is wasted work
 *     and, if the override happened to point at an internal object we delete,
 *     could 404 the image.
 *
 * Belt-and-suspenders: callers also exclude these in their scan WHERE, but this
 * guard keeps the two honest if a scan ever drifts.
 *
 * Returns the reason (for logging/skip-bucketing) or `false` when eligible.
 */
export function isReprocessIneligible(row: ReprocessRow): "gif" | "override" | false {
  if (row.mime_type === "image/gif") return "gif";
  if (row.url_override && row.url_override.trim() !== "") return "override";
  return false;
}

/** The fresh `-nobg` variant family + the old objects to reap, post-détourage. */
export type ReprocessVariants = {
  primaryKey: string;
  webpKey: string | null;
  avifKey: string | null;
  jpeg: Buffer;
  webp: Buffer | null;
  avif: Buffer | null;
  /** Pixel dimensions of the reprocessed output — so the media row's width/height
   *  stay truthful after re-keying (they'd otherwise keep the pre-détourage values). */
  width: number;
  height: number;
  /**
   * Old objects to delete once the row is repointed (incl. a kept original).
   * CANDIDATES only: order lines snapshot the resolved `/cdn/<key>` URL, so the
   * in-app job skips any key an order still displays
   * (`listOrderReferencedStorageKeys`) before reaping.
   */
  oldKeysToDelete: string[];
  /** filename re-keyed to the new `.jpg` primary (null when the row had none). */
  newFilename: string | null;
};

const stripExt = (key: string) => key.replace(/\.[^./]+$/, "");

/**
 * Run the flood-fill removal and, when the packshot WAS a uniform sweep, build
 * the fresh `-nobg` variant family + the list of old objects to delete. Returns
 * `null` when the image had no removable backdrop (caller treats as "skipped").
 *
 * Honours the store's `media_settings`:
 *   - encoder qualities match a fresh upload (no hard-coded 82/60/85);
 *   - a disabled webp/avif format is NOT generated, and its key is `null`, so a
 *     reprocessed image never gains a variant the admin turned off.
 * The white-flattened JPEG primary is ALWAYS produced — it is the universal
 * `url` fallback the resolver serves to non-webp/avif clients.
 */
export async function buildReprocessedDetourage(
  row: ReprocessRow,
  primaryBytes: Buffer,
  settings: ReprocessEncodeSettings,
): Promise<ReprocessVariants | null> {
  const res = await removeUniformBackground(primaryBytes);
  if (!res.changed) return null;

  // removeUniformBackground returns RAW RGBA (no PNG round-trip); each encoder
  // reads it via the `raw` constructor option under the same ~50 MP decode cap.
  const rawOpts = {
    raw: { width: res.width, height: res.height, channels: 4 as const },
    ...SHARP_DECODE_LIMITS,
  };
  const [webp, avif, jpegOut] = await Promise.all([
    settings.generateWebp
      ? sharp(res.data, rawOpts).webp({ quality: settings.webpQuality, effort: 4 }).toBuffer()
      : Promise.resolve(null),
    settings.generateAvif
      ? sharp(res.data, rawOpts).avif({ quality: settings.avifQuality, effort: 4 }).toBuffer()
      : Promise.resolve(null),
    sharp(res.data, rawOpts)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: settings.jpegQuality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true }),
  ]);
  const jpeg = jpegOut.data;

  // Fresh keys (cache-bust): same prefix, "-nobg" marker, deterministic exts —
  // so immutable caches can't keep serving the old version.
  const base = `${stripExt(row.storage_key)}-nobg`;
  const oldBase = stripExt(row.storage_key);

  // Reap the old primary + webp/avif siblings, plus the kept original if any.
  // We null original_url on the row below, so variantStorageKeys() could never
  // re-derive (and thus never GC) that object on a future delete — delete it
  // now or it leaks in the bucket forever.
  const oldKeysToDelete = [row.storage_key, `${oldBase}.webp`, `${oldBase}.avif`];
  if (row.original_url) {
    const m = row.original_url.match(/\.([a-z0-9]+)(?:\?|$)/i);
    if (m?.[1]) oldKeysToDelete.push(`${oldBase}.original.${m[1].toLowerCase()}`);
  }

  return {
    primaryKey: `${base}.jpg`,
    webpKey: settings.generateWebp ? `${base}.webp` : null,
    avifKey: settings.generateAvif ? `${base}.avif` : null,
    jpeg,
    webp,
    avif,
    width: jpegOut.info.width,
    height: jpegOut.info.height,
    oldKeysToDelete,
    // Keep the Médiathèque label + filename-trigram search in step with the
    // served bytes (now a `.jpg`), mirroring the upload path's filename keying
    // (upload-media.ts keys filename to the primary variant's real ext).
    newFilename: row.filename ? `${stripExt(row.filename)}.jpg` : null,
  };
}
