import "server-only";

import path from "node:path";

import { mediaService } from "@/modules/media/service";
import {
  getMaxUploadBytes,
  isAcceptedImageMime,
  processImage,
  type ProcessedVariant,
} from "@/modules/media/processor";
import { isImageTooLargeError, isUnsupportedImageFormatError } from "@/modules/media/image-safety";
import { mediaSettingsService } from "@/modules/media/settings.service";
import {
  buildStorageKey,
  deleteObject,
  putObject,
  variantKey,
  variantStorageKeys,
  variantUploadKeys,
} from "@/modules/media/storage";
import { bus } from "@/events/bus";
import { fail, ok, workflow } from "../shared";

/**
 * Upload-media workflow.
 *
 * Inputs: a single browser-uploaded file + scope + actor id.
 * Outputs: the resulting media row id and its canonical URL.
 *
 * Pipeline:
 *   1. validate MIME + size (settings-driven ceiling)
 *   2. process the source bytes into up to four variants (jpeg/webp/avif/original)
 *      — the quality-controlled JPEG is the canonical primary (the row `url`)
 *   3. PUT each variant to the object store under a shared base key
 *   4. persist one media row tracking every variant's URL + size
 *   5. emit `media.uploaded`
 *
 * If ANY enabled variant PUT fails, the workflow purges every object already
 * uploaded for this media and aborts BEFORE inserting — so the DB never sees a
 * partially-wired row pointing at deleted objects. If the row INSERT itself
 * throws after every PUT landed, the same purge runs before the error surfaces.
 *
 * There is NO bucket-wide orphan sweep (nothing lists the bucket and diffs it
 * against the media rows), so these purges are the only reclamation for an
 * aborted upload: an object whose delete also fails leaks until removed by
 * hand — its key is logged for that.
 */

type UploadInput = {
  file: File;
  scope: "products" | "categories" | "brands" | "cms" | "uploads";
  altText?: string;
  uploadedBy: string;
};

/** Max stored alt-text length — bounds row bloat like the 200-char filename cap
 *  + the 2000-char url_override cap, so every free-text media field is bounded. */
export const ALT_TEXT_MAX = 500;

/** Trim + cap alt text; null-safe (empty/whitespace → null). */
function clampAlt(alt: string | null | undefined): string | null {
  const t = alt?.trim();
  return t ? t.slice(0, ALT_TEXT_MAX) : null;
}

export const uploadMediaWorkflow = workflow<
  [UploadInput],
  { mediaId: string; url: string }
>("media.upload", async (input) => {
  if (!input.file) return fail("validation", "Fichier requis.");

  // Defence in depth: settings-driven ceiling (media_settings.max_upload_mb),
  // even though the admin UI also limits and Next.js itself caps body size.
  const maxBytes = await getMaxUploadBytes();
  if (input.file.size > maxBytes) {
    return fail(
      "file_too_large",
      `Le fichier dépasse ${(maxBytes / 1024 / 1024).toFixed(0)} MB.`,
    );
  }
  if (!isAcceptedImageMime(input.file.type)) {
    return fail("invalid_type", "Format non supporté. Utilisez JPG, PNG, WebP, AVIF ou GIF.");
  }

  const buffer = Buffer.from(await input.file.arrayBuffer());

  let processed;
  try {
    // Pass the upload scope so the processor can apply the product-only
    // auto white-background removal (détourage) (admin toggle `product_white_bg`).
    processed = await processImage(buffer, input.file.type, { scope: input.scope });
  } catch (err) {
    // Decode cap (~50 MP, decompression-bomb guard) → a clear operator message.
    if (isImageTooLargeError(err)) return fail("image_too_large", err.message);
    // Mislabeled non-raster (SVG/TIFF/HEIF as image/png) caught on the decoded
    // format → the precise "format non supporté" rather than the generic failure.
    if (isUnsupportedImageFormatError(err)) return fail("invalid_type", err.message);
    console.error("[workflow:media.upload] sharp failed", err);
    return fail("processing_failed", "Impossible de traiter l'image.");
  }

  // Build a base key WITHOUT extension so every variant gets a sibling key.
  // Example (products scope):
  //   products/<uuid>-screenshot.jpg            (primary → row url)
  //   products/<uuid>-screenshot.webp
  //   products/<uuid>-screenshot.avif
  //   products/<uuid>-screenshot.original.gif   (kept original, when keep_original on)
  const baseName = path.parse(input.file.name).name || "image";
  const baseKey = buildStorageKey({ scope: input.scope, filename: baseName });

  // Purge EVERY key this upload could have written for baseKey, NOT just the
  // PUTs we recorded as succeeding. Two reasons a "recorded successes" list is
  // insufficient: (1) a PUT can throw AFTER the object actually landed in the object store
  // (a transient error on the response), and (2) variants are PUT sequentially
  // with no early-return, so a later variant lands AFTER an earlier one failed.
  // Deleting the full candidate set (a harmless no-op for keys never written)
  // leaves no orphan. variantUploadKeys mirrors variantStorageKeys so this
  // cleanup and the media.deleted reap derive identical keys. The
  // `!== processed.primary` guard on `original` excludes the GIF/fallback case
  // where original reuses the primary key (disabled variants are undefined).
  // Defined BEFORE the first PUT so even a failed PRIMARY PUT (whose object may
  // still have landed before the response threw) is reclaimed, not leaked.
  const uploadKeys = variantUploadKeys(baseKey, {
    primaryExt: processed.primary.ext,
    webp: Boolean(processed.webp),
    avif: Boolean(processed.avif),
    originalExt:
      processed.original && processed.original !== processed.primary
        ? processed.original.ext
        : null,
  });
  async function purgeUploadedObjects(): Promise<void> {
    for (const key of uploadKeys) {
      try {
        await deleteObject(key);
      } catch (err) {
        // Best-effort, and NOTHING else reclaims it (no bucket sweep exists):
        // log the key so the leaked object can be removed by hand.
        console.error("[workflow:media.upload] orphan object delete failed", { key, err });
      }
    }
  }

  async function pushVariant(
    variant: ProcessedVariant | undefined,
    label: "primary" | "webp" | "avif" | "original",
  ): Promise<{ key: string; url: string } | null> {
    if (!variant) return null;
    // `variantKey` is the single source of truth for the key shape (the kept
    // original gets a distinct `.original.<ext>` so a same-ext source can't
    // overwrite the quality-controlled primary). When original IS the primary —
    // GIFs / no-variant fallback — this isn't reached; the caller reuses the key.
    const key = variantKey(baseKey, label, variant.ext);
    try {
      return await putObject({ key, body: variant.data, contentType: variant.mimeType });
    } catch (err) {
      console.error("[workflow:media.upload] S3 PUT failed", { variant: label, err });
      return null;
    }
  }

  const primaryUp = await pushVariant(processed.primary, "primary");
  if (!primaryUp) {
    // The primary object may have landed before the PUT threw — reclaim it too.
    await purgeUploadedObjects();
    return fail("storage_failed", "Échec du téléversement.");
  }
  // webp/avif are always distinct objects from the primary (primary = jpeg ??
  // original — never a webp/avif), so each uploads under its own key.
  const webpUp = processed.webp ? await pushVariant(processed.webp, "webp") : null;
  const avifUp = processed.avif ? await pushVariant(processed.avif, "avif") : null;
  // The original CAN equal the primary (GIF / no-variant fallback) — reuse the
  // primary key then, instead of re-uploading identical bytes under a second key.
  const originalUp =
    processed.original && processed.original !== processed.primary
      ? await pushVariant(processed.original, "original")
      : processed.original === processed.primary
        ? { key: primaryUp.key, url: primaryUp.url }
        : null;

  // If an enabled, non-primary variant failed to upload, abort before persisting
  // so the DB never sees a row pointing at a half-wired object set.
  if (
    (processed.webp && !webpUp) ||
    (processed.avif && !avifUp) ||
    (processed.original && processed.original !== processed.primary && !originalUp)
  ) {
    await purgeUploadedObjects();
    return fail("storage_failed", "Échec du téléversement.");
  }

  let row: Awaited<ReturnType<typeof mediaService.insert>>;
  try {
    const settings = await mediaSettingsService.get();
    const altText = clampAlt(input.altText ?? settings.default_alt_text);

    row = await mediaService.insert({
      kind: "image",
      storage_key: primaryUp.key,
      url: primaryUp.url,
      // Stored filename carries the PRIMARY variant's extension (e.g. a re-encoded
      // PNG/import lands as `.jpg`) so the Médiathèque label + filename trigram
      // search match the bytes actually served, not the upload's original ext.
      filename: `${baseName}.${processed.primary.ext}`,
      mime_type: processed.primary.mimeType,
      size_bytes: processed.primary.sizeBytes,
      width: processed.width,
      height: processed.height,
      alt_text: altText,
      uploaded_by: input.uploadedBy,
      webp_url: webpUp?.url ?? null,
      webp_size_bytes: processed.webp?.sizeBytes ?? null,
      avif_url: avifUp?.url ?? null,
      avif_size_bytes: processed.avif?.sizeBytes ?? null,
      original_url: originalUp?.url ?? null,
      original_size_bytes: processed.original?.sizeBytes ?? null,
      original_mime_type: processed.original?.mimeType ?? null,
    });
  } catch (err) {
    // Every PUT landed but no row will ever point at the objects — reclaim them,
    // then rethrow so the workflow() wrapper maps the error as before.
    await purgeUploadedObjects();
    throw err;
  }

  await bus.emit(
    "media.uploaded",
    { mediaId: row.id, storageKey: row.storage_key, sizeBytes: row.size_bytes },
    { actorUserId: input.uploadedBy },
  );

  return ok({ mediaId: row.id, url: row.url });
});

export const deleteMediaWorkflow = workflow<
  [{ mediaId: string }, { actorUserId: string }],
  { mediaId: string }
>("media.delete", async ({ mediaId }, { actorUserId }) => {
  const row = await mediaService.findById(mediaId);
  if (!row) return fail("not_found", "Image introuvable.");

  // Soft-delete the DB row (a tombstone — keeps soft `media_id` links / order
  // snapshots from dangling), then let the `cleanup-media-storage` subscriber
  // purge every variant object from S3. Centralised so single- and bulk-delete
  // share one path; `bus.emit` awaits its subscribers, so the objects are gone
  // by the time this returns. NOTE: storage is reclaimed immediately, so the
  // tombstoned row is NOT byte-recoverable — the tombstone is for referential
  // safety, not undo.
  await mediaService.softDelete(mediaId);

  await bus.emit(
    "media.deleted",
    {
      mediaId: row.id,
      storageKey: row.storage_key,
      storageKeys: variantStorageKeys(row),
    },
    { actorUserId },
  );
  return ok({ mediaId });
});

/**
 * Update workflow — patches editable metadata.
 *
 *   `urlOverride: null` clears any override and falls back to the variant
 *   URLs. `urlOverride: ""` (empty string) also clears.
 */
export const updateMediaWorkflow = workflow<
  [
    {
      mediaId: string;
      altText?: string | null;
      filename?: string;
      urlOverride?: string | null;
    },
    { actorUserId: string },
  ],
  { mediaId: string }
>("media.update", async (input, { actorUserId }) => {
  const row = await mediaService.findById(input.mediaId);
  if (!row) return fail("not_found", "Image introuvable.");

  const patch: Parameters<typeof mediaService.update>[1] = {};
  if (input.altText !== undefined) patch.alt_text = clampAlt(input.altText);
  if (input.filename !== undefined && input.filename.trim().length > 0) {
    patch.filename = input.filename.trim().slice(0, 200);
  }
  if (input.urlOverride !== undefined) {
    const trimmed = input.urlOverride?.trim();
    patch.url_override = trimmed && trimmed.length > 0 ? trimmed : null;
  }

  if (Object.keys(patch).length === 0) return ok({ mediaId: input.mediaId });

  await mediaService.update(input.mediaId, patch);
  await bus.emit(
    "media.updated",
    { mediaId: input.mediaId, changedFields: Object.keys(patch) },
    { actorUserId },
  );
  return ok({ mediaId: input.mediaId });
});
