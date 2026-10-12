/**
 * Offline uniform-backdrop REMOVAL for the demo's existing product media.
 *
 * The upload processor now removes uniform studio backdrops on NEW product
 * uploads (admin toggle "Détourage automatique du fond"), but the demo
 * catalogue was imported before that — its packshots still sit in a flat
 * rectangle. This script re-processes them in place:
 *
 *   for each product image (skipping GIFs + url_override-pinned rows):
 *     fetch primary bytes → removeUniformBackground() (flood-fill from edges)
 *       → if it's a uniform-sweep packshot (white, black, grey, flat colour):
 *            write transparent WebP + AVIF + a white-flattened JPEG fallback
 *            under FRESH `-nobg` keys (so immutable caches don't serve the old
 *            version), then repoint the media row at the new keys.
 *       → otherwise (lifestyle / textured bg): leave it untouched.
 *
 * The per-row image work is shared with the in-app job via
 * `src/modules/media/reprocess-detourage` so the two paths can't drift. Encoder
 * qualities + variant flags are read from the `media_settings` row so output
 * matches a fresh upload on this store.
 *
 * Same source rules as the in-app job (`src/modules/media/reprocess-source`):
 * an image already transparent (cut out at upload) is skipped, and a kept
 * original is the source and is PRESERVED (re-keyed beside the `-nobg` family).
 * Otherwise irreversible: the old primary/WebP/AVIF objects are deleted.
 *
 * Idempotent: rows already on a `-nobg` key are skipped, so it's safe to re-run.
 * Also flips the `product_white_bg` media setting ON so future uploads match.
 *
 *   pnpm tsx --env-file-if-exists=.env.local scripts/reprocess-product-white-bg.ts [--limit N] [--dry]
 */
import { Pool } from "pg";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";

import {
  buildReprocessedDetourage,
  isReprocessIneligible,
  type ReprocessEncodeSettings,
} from "../src/modules/media/reprocess-detourage";
import {
  hasTransparency,
  isMissingObjectError,
  keptOriginalKey,
  prepareOriginalSource,
  rekeyedOriginalKey,
  transparencyProbeKey,
} from "../src/modules/media/reprocess-source";

const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  return i >= 0 ? parseInt(process.argv[i + 1], 10) || 0 : 0;
})();
const DRY = process.argv.includes("--dry");
const CONCURRENCY = 6;

const env = (k: string, d: string) => process.env[k]?.trim() || d;
const BUCKET = env("S3_BUCKET", "tokyo");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgresql://tokyo:tokyo_dev_pwd@localhost:5434/tokyo",
});
const q = (t: string, p: unknown[] = []) => pool.query(t, p);

const s3 = new S3Client({
  region: env("S3_REGION", "us-east-1"),
  endpoint: env("S3_ENDPOINT", "http://localhost:9000"),
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") !== "false",
  credentials: {
    accessKeyId: env("S3_ACCESS_KEY", "seaweedfs"),
    secretAccessKey: env("S3_SECRET_KEY", "seaweedfs_dev_secret"),
  },
});

const publicUrlFor = (key: string) =>
  `/cdn/${key.replace(/^\/+/, "").replace(/\/+$/, "").split("/").map(encodeURIComponent).join("/")}`;

async function getBytes(key: string): Promise<Buffer> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const arr = await (res.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
  return Buffer.from(arr);
}

async function putBytes(key: string, body: Buffer, contentType: string) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
}

async function deleteKey(key: string) {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch {
    // Best-effort cleanup — a missing/already-gone object is fine.
  }
}

/**
 * The subset of bucket `keys` an ORDER LINE still displays — a raw-SQL mirror of
 * mediaQueries.listOrderReferencedStorageKeys (this offline script has its own pg
 * pool and can't import the `server-only` module). Order lines snapshot the
 * RESOLVED /cdn URL (never a media id), so a purge that ignores them would break
 * historical order thumbnails + already-sent emails. Match = the snapshot URL
 * ends with `/<per-segment-encoded key>`. KEEP IN SYNC with the module version.
 */
async function orderReferencedKeys(keys: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = [...new Set(keys.filter((k) => typeof k === "string" && k !== ""))];
  if (unique.length === 0) return out;
  const rows = unique.map((key) => {
    const encoded = key.replace(/^\/+/, "").replace(/\/+$/, "").split("/").map(encodeURIComponent).join("/");
    return { key, encoded, tail: encoded.slice(encoded.lastIndexOf("/") + 1) };
  });
  const values: string[] = [];
  const params: string[] = [];
  rows.forEach((r, i) => {
    const b = i * 3;
    values.push(`($${b + 1},$${b + 2},$${b + 3})`);
    params.push(r.key, r.encoded, r.tail);
  });
  const res = await q(
    `SELECT DISTINCT k.key
       FROM (VALUES ${values.join(",")}) AS k(key, enc, tail)
       JOIN (
         SELECT u.url
         FROM order_items oi
         CROSS JOIN LATERAL (VALUES (oi.product_image_url), (oi.variant_image_url)) AS u(url)
         WHERE u.url IS NOT NULL AND u.url <> ''
       ) o
         ON regexp_replace(o.url, '^.*/', '') = k.tail
        AND right(o.url, length(k.enc) + 1) = '/' || k.enc`,
    params,
  );
  for (const row of res.rows as { key: string }[]) out.add(row.key);
  return out;
}

type Row = {
  id: string;
  storage_key: string;
  mime_type: string | null;
  url_override: string | null;
  webp_url: string | null;
  avif_url: string | null;
  original_url: string | null;
  original_size_bytes: string | number | null;
  original_mime_type: string | null;
  filename: string | null;
};

async function processOne(
  row: Row,
  settings: ReprocessEncodeSettings,
  caps: { maxWidth: number; maxHeight: number },
  stats: { changed: number; skipped: number; errors: number },
) {
  try {
    // Skip GIFs + url_override-pinned rows (the scan also excludes them, but
    // this keeps the script honest if the SQL drifts).
    if (isReprocessIneligible(row)) {
      stats.skipped++;
      return;
    }
    // Already transparent (cut out at upload) → re-flooding its flattened JPEG
    // primary would only degrade it.
    const probeKey = transparencyProbeKey(row);
    if (probeKey) {
      const probe = await getBytes(probeKey).catch(() => null);
      if (probe && (await hasTransparency(probe).catch(() => false))) {
        stats.skipped++;
        return;
      }
    }
    // Source: the kept original when there is one (a missing object falls back
    // to the primary; any other read failure aborts this row, never the original).
    const original = keptOriginalKey(row);
    let originalBytes: Buffer | null = null;
    if (original) {
      try {
        originalBytes = await getBytes(original.key);
      } catch (err) {
        if (!isMissingObjectError(err)) throw err;
      }
    }
    const source = originalBytes
      ? await prepareOriginalSource(originalBytes, caps)
      : await getBytes(row.storage_key);
    const built = await buildReprocessedDetourage(row, source, settings);
    if (!built) {
      stats.skipped++;
      return;
    }

    if (DRY) {
      stats.changed++;
      return;
    }

    // The kept original is PRESERVED, re-keyed beside the new family.
    const keptOriginal =
      original && originalBytes ? rekeyedOriginalKey(built.primaryKey, original.ext) : null;

    await Promise.all([
      putBytes(built.primaryKey, built.jpeg, "image/jpeg"),
      ...(built.webp && built.webpKey ? [putBytes(built.webpKey, built.webp, "image/webp")] : []),
      ...(built.avif && built.avifKey ? [putBytes(built.avifKey, built.avif, "image/avif")] : []),
      ...(keptOriginal && originalBytes
        ? [putBytes(keptOriginal, originalBytes, row.original_mime_type ?? "application/octet-stream")]
        : []),
    ]);

    // Repoint the row at the new `-nobg` key family. The original_* columns
    // follow the re-keyed original; with none kept they're cleared — leaving
    // them on the OLD object would make variantStorageKeys() reap a bogus
    // `<newBase>.original.*` on delete while the real old object leaks. The old
    // original key is reaped explicitly below (it's in `oldKeysToDelete`).
    await q(
      `UPDATE media SET storage_key=$1, url=$2, mime_type='image/jpeg', size_bytes=$3,
         webp_url=$4, webp_size_bytes=$5, avif_url=$6, avif_size_bytes=$7,
         filename=COALESCE($8, filename),
         original_url=$9, original_size_bytes=$10, original_mime_type=$11,
         width=$13, height=$14, updated_at=now()
       WHERE id=$12`,
      [
        built.primaryKey,
        publicUrlFor(built.primaryKey),
        built.jpeg.length,
        built.webpKey ? publicUrlFor(built.webpKey) : null,
        built.webp ? built.webp.length : null,
        built.avifKey ? publicUrlFor(built.avifKey) : null,
        built.avif ? built.avif.length : null,
        built.newFilename,
        keptOriginal ? publicUrlFor(keptOriginal) : null,
        keptOriginal ? row.original_size_bytes : null,
        keptOriginal ? row.original_mime_type : null,
        row.id,
        built.width,
        built.height,
      ],
    );

    // Row now references only the new keys → delete the orphaned old objects
    // (old primary + webp/avif siblings + the OLD key of the kept original,
    // whose bytes now live under `keptOriginal`). But KEEP any old key an order
    // line still displays (order_items snapshot the resolved /cdn URL, not the
    // media id) so historical order thumbnails don't break — mirrors the in-app
    // job. If the lookup fails, keep all (safe direction).
    const pinned = await orderReferencedKeys(built.oldKeysToDelete).catch(
      () => new Set(built.oldKeysToDelete),
    );
    await Promise.all(built.oldKeysToDelete.filter((k) => !pinned.has(k)).map((k) => deleteKey(k)));
    stats.changed++;
  } catch (err) {
    stats.errors++;
    console.error(`[white-bg] ${row.id} (${row.storage_key}) failed:`, (err as Error).message);
  }
}

async function main() {
  if (!DRY) {
    // Turn the feature ON so future product uploads also get detourage.
    await q(`UPDATE media_settings SET product_white_bg = true, updated_at = now()`);
  }

  // Encoder qualities + variant flags from the singleton settings row, so the
  // offline backfill matches what a fresh upload produces on this store.
  const sr = (
    await q(
      `SELECT jpeg_quality, webp_quality, avif_quality, generate_webp, generate_avif,
              max_width_px, max_height_px
       FROM media_settings LIMIT 1`,
    )
  ).rows[0] as
    | {
        jpeg_quality: number;
        webp_quality: number;
        avif_quality: number;
        generate_webp: boolean;
        generate_avif: boolean;
        max_width_px: number;
        max_height_px: number;
      }
    | undefined;
  const settings: ReprocessEncodeSettings = {
    jpegQuality: sr?.jpeg_quality ?? 85,
    webpQuality: sr?.webp_quality ?? 82,
    avifQuality: sr?.avif_quality ?? 60,
    generateWebp: sr?.generate_webp ?? true,
    generateAvif: sr?.generate_avif ?? true,
  };
  // Upload pre-stage caps the kept original is normalised to (processor.ts).
  const caps = { maxWidth: sr?.max_width_px ?? 2400, maxHeight: sr?.max_height_px ?? 2400 };

  // Exclude GIFs + url_override-pinned rows at the source (mirrors the shared
  // eligibility guard).
  const rows = (
    await q(
      `SELECT DISTINCT m.id, m.storage_key, m.mime_type, m.url_override, m.webp_url, m.avif_url,
              m.original_url, m.original_size_bytes, m.original_mime_type, m.filename
       FROM media m
       JOIN product_media pm ON pm.media_id = m.id
       WHERE m.kind = 'image' AND m.deleted_at IS NULL AND m.storage_key NOT LIKE '%-nobg.%'
         AND m.mime_type IS DISTINCT FROM 'image/gif'
         AND (m.url_override IS NULL OR m.url_override = '')
       ORDER BY m.id ${LIMIT > 0 ? `LIMIT ${LIMIT}` : ""}`,
    )
  ).rows as Row[];

  console.log(`[white-bg] ${rows.length} product image(s) to scan${DRY ? " (dry run)" : ""}…`);
  const stats = { changed: 0, skipped: 0, errors: 0 };

  // Simple bounded worker pool.
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const row = rows[i++];
      await processOne(row, settings, caps, stats);
      const done = stats.changed + stats.skipped + stats.errors;
      if (done % 25 === 0) console.log(`[white-bg] ${done}/${rows.length} (cut:${stats.changed} skip:${stats.skipped} err:${stats.errors})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`[white-bg] done. cut=${stats.changed} skipped=${stats.skipped} errors=${stats.errors}`);
  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error("[white-bg] fatal:", e);
  process.exit(1);
});
