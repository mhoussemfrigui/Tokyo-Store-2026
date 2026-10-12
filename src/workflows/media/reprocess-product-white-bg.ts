import "server-only";

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { and, eq, inArray, isNull, notLike, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import { emitProductStockCacheBust } from "@/lib/catalog/product-cache-bust";
import { product_media } from "@/associations/product-media";
import { media } from "@/modules/media/schema";
import { listOrderReferencedStorageKeys } from "@/modules/media/queries";
import { getS3Client, putObject, deleteObject, publicUrlFor } from "@/modules/media/storage";
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
import { mediaSettingsService } from "@/modules/media/settings.service";
import { serverEnv } from "@/lib/env";
import { emptyDataJobResult, importJobService } from "@/modules/import";

/**
 * Background runner: re-process EXISTING product packshots for uniform-backdrop
 * removal (détourage), in place.
 *
 * Enabling the `product_white_bg` media setting only affects FUTURE uploads
 * (the processor gates on it). The demo catalogue — and anything imported
 * before the toggle — keeps its uniform-sweep packshots. This job scans every
 * product image not already on a `-nobg` key, runs the flood-fill removal, and
 * (for the ones that ARE uniform-sweep packshots) writes a fresh transparent
 * WebP + AVIF + white-flattened JPEG family under `-nobg` keys, repoints the
 * media row, and reaps the old objects. An image that is ALREADY transparent
 * (cut out at upload) is skipped; the kept original, when there is one, is the
 * source and is preserved (re-keyed beside the new family) — see
 * `@/modules/media/reprocess-source`. Irreversible otherwise: the old primary /
 * WebP / AVIF objects are deleted.
 *
 * The per-row image work (eligibility, flood-fill, `-nobg` encoding, old-object
 * list) is shared with the offline `scripts/reprocess-product-white-bg.ts` via
 * `@/modules/media/reprocess-detourage` so the two paths can't drift. Encoder
 * qualities + which variants to emit come from `media_settings` so a
 * reprocessed image matches a fresh upload on this store.
 *
 * Like the other data-job runners it's a plain async function fired
 * fire-and-forget by the server action — nothing awaits it; all outcomes land
 * on the `import_jobs` row (`markRunning` → `updateProgress` → `complete` /
 * `fail`). Single-flight is enforced upstream (the action checks `hasActive`).
 *
 * Sequential (one image at a time): sharp variant generation + S3 round-trips
 * dominate, and a steady progress bar matters more here than raw throughput.
 */

const BUCKET = serverEnv.S3_BUCKET;
const WARNINGS_CAP = 50;

type ScanRow = {
  id: string;
  storage_key: string;
  mime_type: string | null;
  url_override: string | null;
  webp_url: string | null;
  avif_url: string | null;
  original_url: string | null;
  original_size_bytes: number | null;
  original_mime_type: string | null;
  filename: string | null;
};

/** Upload pre-stage caps the kept original is normalised to (processor.ts). */
type SourceCaps = { maxWidth: number; maxHeight: number };

/** Download an object's bytes via the shared S3 client (no getObject helper). */
async function getBytes(key: string): Promise<Buffer> {
  const res = await getS3Client().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const arr = await (
    res.Body as { transformToByteArray(): Promise<Uint8Array> }
  ).transformToByteArray();
  return Buffer.from(arr);
}

/**
 * Re-process ONE media row. Returns "changed" when the packshot was a uniform
 * sweep (new `-nobg` family written + row repointed), "skipped" when the image
 * had no removable backdrop, is already transparent (cut out at upload), or is
 * ineligible (GIF / url_override-pinned).
 */
async function processOne(
  row: ScanRow,
  settings: ReprocessEncodeSettings,
  caps: SourceCaps,
): Promise<"changed" | "skipped"> {
  // The scan already excludes GIFs + override-pinned rows; guard again so a
  // future scan tweak can't silently re-introduce the GIF data-loss path.
  if (isReprocessIneligible(row)) return "skipped";

  // Already transparent (détouré at upload, or a transparent PNG packshot):
  // re-flooding its white-flattened JPEG primary would only degrade it.
  const probeKey = transparencyProbeKey(row);
  if (probeKey) {
    const probe = await getBytes(probeKey).catch(() => null);
    if (probe && (await hasTransparency(probe).catch(() => false))) return "skipped";
  }

  // Source: the kept ORIGINAL when there is one (faithful, never flattened —
  // normalised like the upload pre-stage), else the q-jpeg primary. A missing
  // original object falls back to the primary; any OTHER read failure throws
  // (row counted as failed) rather than risk dropping an original we couldn't
  // copy.
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
  if (!built) return "skipped";

  // The kept original is PRESERVED: re-keyed beside the new family so the
  // repointed row still derives it (variantStorageKeys) — the old key is then
  // reaped with the rest of `oldKeysToDelete`.
  const keptOriginal =
    original && originalBytes ? rekeyedOriginalKey(built.primaryKey, original.ext) : null;

  await Promise.all([
    putObject({ key: built.primaryKey, body: built.jpeg, contentType: "image/jpeg" }),
    ...(built.webp && built.webpKey
      ? [putObject({ key: built.webpKey, body: built.webp, contentType: "image/webp" })]
      : []),
    ...(built.avif && built.avifKey
      ? [putObject({ key: built.avifKey, body: built.avif, contentType: "image/avif" })]
      : []),
    ...(keptOriginal && originalBytes
      ? [
          putObject({
            key: keptOriginal,
            body: originalBytes,
            contentType: row.original_mime_type ?? "application/octet-stream",
          }),
        ]
      : []),
  ]);

  // Repoint the row at the new `-nobg` key family. The original_* columns
  // follow the re-keyed original (so variantStorageKeys() reaps the right
  // object on a later delete); with no original kept they're cleared — leaving
  // them on the OLD object would make variantStorageKeys() reap a bogus
  // `<newBase>.original.*` while the real old object leaks. The old original
  // key is reaped explicitly below (it's in `oldKeysToDelete`).
  await db
    .update(media)
    .set({
      storage_key: built.primaryKey,
      url: publicUrlFor(built.primaryKey),
      mime_type: "image/jpeg",
      size_bytes: built.jpeg.length,
      width: built.width,
      height: built.height,
      webp_url: built.webpKey ? publicUrlFor(built.webpKey) : null,
      webp_size_bytes: built.webp ? built.webp.length : null,
      avif_url: built.avifKey ? publicUrlFor(built.avifKey) : null,
      avif_size_bytes: built.avif ? built.avif.length : null,
      original_url: keptOriginal ? publicUrlFor(keptOriginal) : null,
      original_size_bytes: keptOriginal ? row.original_size_bytes : null,
      original_mime_type: keptOriginal ? row.original_mime_type : null,
      ...(built.newFilename ? { filename: built.newFilename } : {}),
      updated_at: sql`now()`,
    })
    .where(eq(media.id, row.id));

  // Row now references only the new keys → delete the orphaned old objects
  // (old primary + webp/avif siblings + the OLD key of the kept original, whose
  // bytes now live under `keptOriginal`). Best-effort: a
  // missing/already-gone object is fine. Keys an order line still displays
  // (order_items snapshot the resolved /cdn URL, not the media id) are KEPT so
  // historical order thumbnails don't break; if that lookup fails, keep all.
  const pinned = await listOrderReferencedStorageKeys(built.oldKeysToDelete).catch(
    () => new Set(built.oldKeysToDelete),
  );
  await Promise.all(
    built.oldKeysToDelete
      .filter((k) => !pinned.has(k))
      .map((k) => deleteObject(k).catch(() => {})),
  );

  return "changed";
}

/**
 * Détoure ONE product media in place — used by the product-save path when the
 * `product_white_bg_main_only` setting is on, to remove the backdrop of just the
 * product's MAIN (first gallery) image. Reuses the exact per-row work as the bulk
 * job (`processOne`), so eligibility, encoding, order-key pinning + the `-nobg`
 * re-key are identical and can't drift. Idempotent (a row already on a `-nobg`
 * key / a GIF / an override / a non-product media is a no-op) and BEST-EFFORT:
 * it never throws into the caller (an upload/save must not fail on détourage).
 * Emits the product cache-bust when the image actually changed. Returns whether
 * it changed the image.
 */
export async function detourageProductMainImage(
  mediaId: string,
  actorUserId: string | null,
): Promise<boolean> {
  try {
    // Same eligibility gate as the bulk scan, scoped to this one media, and the
    // innerJoin ensures it is actually a PRODUCT image (never a CMS/brand asset).
    const [row] = (await db
      .selectDistinct({
        id: media.id,
        storage_key: media.storage_key,
        mime_type: media.mime_type,
        url_override: media.url_override,
        webp_url: media.webp_url,
        avif_url: media.avif_url,
        original_url: media.original_url,
        original_size_bytes: media.original_size_bytes,
        original_mime_type: media.original_mime_type,
        filename: media.filename,
      })
      .from(media)
      .innerJoin(product_media, eq(product_media.media_id, media.id))
      .where(
        and(
          eq(media.id, mediaId),
          eq(media.kind, "image"),
          isNull(media.deleted_at),
          notLike(media.storage_key, "%-nobg.%"),
          sql`${media.mime_type} is distinct from 'image/gif'`,
          sql`(${media.url_override} is null or ${media.url_override} = '')`,
        ),
      )
      .limit(1)) as ScanRow[];
    if (!row) return false;

    const s = await mediaSettingsService.get();
    const settings: ReprocessEncodeSettings = {
      jpegQuality: s.jpeg_quality,
      webpQuality: s.webp_quality,
      avifQuality: s.avif_quality,
      generateWebp: s.generate_webp,
      generateAvif: s.generate_avif,
    };
    const caps: SourceCaps = { maxWidth: s.max_width_px, maxHeight: s.max_height_px };

    const outcome = await processOne(row, settings, caps);
    if (outcome !== "changed") return false;

    const owners = await db
      .selectDistinct({ productId: product_media.product_id })
      .from(product_media)
      .where(eq(product_media.media_id, mediaId))
      .catch(() => [] as { productId: string }[]);
    await emitProductStockCacheBust(owners.map((o) => o.productId), actorUserId, ["image"]).catch(() => {});
    // The repoint changed this média's resolved /cdn URL and reaped the old
    // objects. A média can be SHARED with a category/brand/CMS
    // page/blog post, whose cached surfaces the product bust above does NOT
    // cover — so also fire media.updated (invalidate-media-cache busts the broad
    // storefront tags), honouring the "média URL moved → bust storefront"
    // contract for shared assets.
    await bus.emit("media.updated", { mediaId, changedFields: ["url"] }, { actorUserId }).catch(() => {});
    return true;
  } catch (err) {
    console.error("[white-bg] main-image détourage failed", { mediaId, err });
    return false;
  }
}

export async function runProductWhiteBgReprocess(
  jobId: string,
  actorUserId: string,
): Promise<void> {
  const job = await importJobService.findById(jobId);
  if (!job || job.status !== "queued") return; // re-entry / stale call guard

  const result = emptyDataJobResult();

  try {
    // Encoder qualities + which variants to emit come from the live settings so
    // reprocessed images match what a fresh upload would produce on this store.
    const s = await mediaSettingsService.get();
    const settings: ReprocessEncodeSettings = {
      jpegQuality: s.jpeg_quality,
      webpQuality: s.webp_quality,
      avifQuality: s.avif_quality,
      generateWebp: s.generate_webp,
      generateAvif: s.generate_avif,
    };
    const caps: SourceCaps = { maxWidth: s.max_width_px, maxHeight: s.max_height_px };

    // Distinct product images not already on a `-nobg` key. JOIN to
    // product_media so non-product media (categories, brands, CMS) is excluded.
    // Exclude GIFs (sharp would freeze the animation into a static `-nobg`
    // family that wins the resolver chain) and url_override-pinned rows (the
    // storefront serves the override, so the rewrite is wasted + can 404).
    const rows: ScanRow[] = await db
      .selectDistinct({
        id: media.id,
        storage_key: media.storage_key,
        mime_type: media.mime_type,
        url_override: media.url_override,
        webp_url: media.webp_url,
        avif_url: media.avif_url,
        original_url: media.original_url,
        original_size_bytes: media.original_size_bytes,
        original_mime_type: media.original_mime_type,
        filename: media.filename,
      })
      .from(media)
      .innerJoin(product_media, eq(product_media.media_id, media.id))
      .where(
        and(
          eq(media.kind, "image"),
          isNull(media.deleted_at),
          notLike(media.storage_key, "%-nobg.%"),
          sql`${media.mime_type} is distinct from 'image/gif'`,
          sql`(${media.url_override} is null or ${media.url_override} = '')`,
        ),
      );

    await importJobService.markRunning(jobId, rows.length);

    let processed = 0;
    const changedMediaIds: string[] = [];
    for (const row of rows) {
      try {
        const outcome = await processOne(row, settings, caps);
        if (outcome === "changed") {
          result.mediaCreated += 1;
          changedMediaIds.push(row.id);
        } else result.skipped += 1;
      } catch (err) {
        // One image failing must not abort the whole job.
        result.mediaFailed += 1;
        if (result.warnings.length < WARNINGS_CAP) {
          const message = err instanceof Error ? err.message : String(err);
          result.warnings.push(`${row.storage_key} : ${message}`);
        }
      }
      processed += 1;
      await importJobService.updateProgress(jobId, processed);
    }

    await importJobService.complete(jobId, processed, result);

    // The reprocess repointed these media at NEW `-nobg` keys AND deleted the old
    // objects — a cached PDP still holding the old image URL would 404 its image.
    // Emit the per-product bust for every product whose image changed. This
    // runner is DETACHED, so the Next tag bust it triggers is best-effort (the
    // starting action's request already flushed its revalidations — routing
    // through the bus doesn't change that); the authoritative bust is
    // `getReprocessJobStatusAction`, which expires the storefront tags from its
    // own live request the first time it sees this job finished.
    if (changedMediaIds.length > 0) {
      const owners = await db
        .selectDistinct({ productId: product_media.product_id })
        .from(product_media)
        .where(inArray(product_media.media_id, changedMediaIds))
        .catch(() => [] as { productId: string }[]);
      await emitProductStockCacheBust(
        owners.map((o) => o.productId),
        actorUserId,
        ["image"],
      );
    }
  } catch (err) {
    // Unexpected crash (e.g. the scan query) — persist the failure WITH the
    // partial result so the operator sees what landed before the abort.
    console.error("[white-bg-reprocess] runner crashed", err);
    await importJobService
      .fail(jobId, err instanceof Error ? err.message : String(err), result)
      .catch(() => {});
  }
}

/**
 * Scheduled/cron entry for the détourage back-fill (SCHEDULED_JOBS
 * "product_detourage" → runScheduledJob → here). Runs the SAME reprocess as the
 * manual settings-page button, but:
 *   - only when the détourage feature is ON (respects the admin's
 *     `product_white_bg` toggle) — otherwise it's a no-op `skipped`, so a
 *     scheduled run never removes backgrounds the admin turned the feature off for;
 *   - only when no other media job is active (shared `import_jobs` single-flight).
 * Idempotent: images already on a `-nobg` key are skipped, so a daily cron only
 * touches product images added since the last run. Returns a normalised summary
 * for the job-run log. The cron route + the dashboard "run now" both reach it via
 * `runScheduledJob`, so both get the kill-switch + failure logging.
 */
export async function runScheduledProductDetourage(): Promise<{
  status: "ok" | "skipped" | "failed";
  summary: string;
  changed: number;
  skipped: number;
  failed: number;
}> {
  const none = { changed: 0, skipped: 0, failed: 0 } as const;
  const settings = await mediaSettingsService.get().catch(() => null);
  if (!settings?.product_white_bg) {
    return { status: "skipped", summary: "Détourage automatique désactivé — tâche ignorée.", ...none };
  }
  // Shared single-flight: imports / clean / a manual reprocess touch the same
  // media rows + objects, so never run concurrently.
  await importJobService.failStaleRunning(15).catch(() => 0);
  if (await importJobService.hasActive()) {
    return { status: "skipped", summary: "Une autre opération média est déjà en cours.", ...none };
  }
  const job = await importJobService.createIfIdle({
    operation: "reprocess",
    segment: "products",
    source: "upload",
    title: "Détourage planifié des produits",
    created_by: "cron",
  });
  if (!job) {
    return { status: "skipped", summary: "Une autre opération média est déjà en cours.", ...none };
  }
  await runProductWhiteBgReprocess(job.id, "cron");
  const done = await importJobService.findById(job.id);
  const r = done?.result ?? null;
  const changed = r?.mediaCreated ?? 0;
  const skipped = r?.skipped ?? 0;
  const failed = r?.mediaFailed ?? 0;
  return {
    status: done?.status === "failed" ? "failed" : "ok",
    summary: `${changed} image(s) détourée(s), ${skipped} sautée(s), ${failed} échec(s)`,
    changed,
    skipped,
    failed,
  };
}
