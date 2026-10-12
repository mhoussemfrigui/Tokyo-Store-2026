import "server-only";

import { S3Client, DeleteObjectCommand, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";

import { serverEnv } from "@/lib/env";

/**
 * S3-compatible storage client. Defaults to the local SeaweedFS S3 gateway;
 * in production points at the Coolify-managed SeaweedFS (or any S3 endpoint
 * via env overrides — the client is backend-agnostic).
 *
 * Public URLs are emitted as same-origin `/cdn/<key>` paths, served by
 * `src/app/cdn/[...path]/route.ts` which streams from the internal S3
 * endpoint. This sidesteps Next.js 16's SSRF guard on the image
 * optimizer (which blocks loopback / private-IP fetches even with a
 * matching remotePatterns entry) and means the browser never needs to
 * resolve the object-store host directly. See the route handler for full notes.
 */

let cached: S3Client | null = null;

export function getS3Client(): S3Client {
  if (cached) return cached;
  cached = new S3Client({
    region: serverEnv.S3_REGION,
    endpoint: serverEnv.S3_ENDPOINT,
    forcePathStyle: serverEnv.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: serverEnv.S3_ACCESS_KEY,
      secretAccessKey: serverEnv.S3_SECRET_KEY,
    },
  });
  return cached;
}

/**
 * Build a deterministic storage key with a random UUID prefix to prevent
 * filename collisions and path-traversal abuse. A single `<scope>` segment
 * (not `uploads/<scope>`):
 *
 *   <scope>/<uuid>-<safe-filename>   (e.g. products/<uuid>-screenshot.jpg)
 *
 * Dot runs are collapsed and leading/trailing dots trimmed: the `/cdn` proxy
 * rejects any path segment containing `..` (traversal guard), so a filename
 * like "Rolex..jpg" (base "Rolex." → primary `…-rolex..jpg`) used to produce an
 * object that uploaded fine but 400'd on every variant URL, forever. A base
 * ending in `.original` is de-dotted too: `<base>.original.<ext>` is the kept-
 * original key shape the `/cdn` proxy serves to staff only, so a source named
 * "watch.original.jpg" must not turn its PUBLIC primary into such a key.
 */
export function buildStorageKey(opts: {
  scope: "products" | "categories" | "brands" | "cms" | "uploads";
  filename: string;
}): string {
  const safe =
    opts.filename
      .toLowerCase()
      .replace(/[^a-z0-9.\-_]/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^\.+|\.+$/g, "")
      .replace(/\.original$/, "-original")
      // Defang a user `-nobg` token right before a dot: `<base>-nobg.<ext>` is the
      // reserved détourage output shape and the eligibility/skip filter is
      // `storage_key LIKE '%-nobg.%'`, so a source literally named "watch-nobg.jpg"
      // would otherwise be wrongly treated as an already-background-removed image.
      .replace(/-nobg(?=\.)/g, "-no-bg") || "image";
  return `${opts.scope}/${randomUUID()}-${safe}`;
}

/**
 * Public URL the browser can fetch — always a same-origin `/cdn/<key>`
 * relative path, served by the `/cdn/[...path]` route handler.
 *
 * Storage keys are slash-delimited (`scope/<uuid>-<filename>`). We re-encode
 * each segment so accidentally-stored funky characters can't break URL
 * parsing on the consumer side. Leading/trailing slashes are stripped
 * defensively.
 */
export function publicUrlFor(storageKey: string): string {
  const cleaned = storageKey.replace(/^\/+/, "").replace(/\/+$/, "");
  const encoded = cleaned
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `/cdn/${encoded}`;
}

/**
 * The bucket key for ONE variant under an extension-less base key. Single
 * source of truth for the upload key shape: the kept original gets a distinct
 * `.original.<ext>` key so a same-ext source can't overwrite the
 * quality-controlled primary at `${baseKey}.<ext>`.
 */
export function variantKey(
  baseKey: string,
  label: "primary" | "webp" | "avif" | "original",
  ext: string,
): string {
  return label === "original" ? `${baseKey}.original.${ext}` : `${baseKey}.${ext}`;
}

/**
 * EVERY bucket key a single upload could write under one extension-less base
 * key. The FORWARD counterpart of `variantStorageKeys` (which is the reverse,
 * row → keys) — both derive identical key shapes so the upload-abort cleanup
 * and the `media.deleted` reap stay in lock-step.
 *
 * Used by the upload workflow to purge deterministically on a failed variant
 * PUT: it deletes the full candidate set rather than only the PUTs it recorded
 * as succeeding, so an object that landed in the object store despite its PUT throwing
 * (transient error on the response) is still reaped. Deleting a key that was
 * never written is a harmless no-op.
 */
export function variantUploadKeys(
  baseKey: string,
  opts: { primaryExt: string; webp?: boolean; avif?: boolean; originalExt?: string | null },
): string[] {
  const keys = new Set<string>();
  keys.add(variantKey(baseKey, "primary", opts.primaryExt));
  if (opts.webp) keys.add(variantKey(baseKey, "webp", "webp"));
  if (opts.avif) keys.add(variantKey(baseKey, "avif", "avif"));
  if (opts.originalExt) keys.add(variantKey(baseKey, "original", opts.originalExt));
  return Array.from(keys);
}

/** Upload a Buffer / Uint8Array under a given key. */
export async function putObject(opts: {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
  cacheControl?: string;
}): Promise<{ key: string; url: string }> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: serverEnv.S3_BUCKET,
      Key: opts.key,
      Body: opts.body,
      ContentType: opts.contentType,
      CacheControl: opts.cacheControl ?? "public, max-age=31536000, immutable",
    }),
  );
  return { key: opts.key, url: publicUrlFor(opts.key) };
}

/**
 * Read an object's raw bytes + content type straight from the store (signed
 * GetObject, so it never depends on the anonymous `/cdn` proxy being reachable).
 * Returns `null` when the key is missing or the read fails — callers fall back
 * gracefully. Used by printable documents to INLINE an image as a base64 data
 * URL: their auto-print fires almost immediately and can't wait for a `/cdn`
 * round-trip, exactly like the order QR codes they already inline.
 */
export async function getObjectBytes(
  key: string,
): Promise<{ body: Buffer; contentType: string | null } | null> {
  try {
    const res = await getS3Client().send(
      new GetObjectCommand({ Bucket: serverEnv.S3_BUCKET, Key: key }),
    );
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return { body: Buffer.from(bytes), contentType: res.ContentType ?? null };
  } catch {
    return null;
  }
}

/** Permanently remove an object. */
export async function deleteObject(key: string): Promise<void> {
  await getS3Client().send(
    new DeleteObjectCommand({
      Bucket: serverEnv.S3_BUCKET,
      Key: key,
    }),
  );
}

/**
 * Derive the bucket keys for every stored variant of a media row. The base
 * `storage_key` carries the primary variant's extension; the webp/avif/original
 * siblings share the same prefix. Used by the `cleanup-media-storage`
 * subscriber to purge all objects when a media row is deleted, and by the
 * service's bulk delete to capture keys before the row is gone.
 */
export function variantStorageKeys(row: {
  storage_key: string;
  webp_url: string | null;
  avif_url: string | null;
  original_url: string | null;
}): string[] {
  const keys = new Set<string>();
  keys.add(row.storage_key);
  // Strip the primary ext from the base key — siblings share the prefix.
  const baseNoExt = row.storage_key.replace(/\.[^./]+$/, "");
  if (row.webp_url) keys.add(`${baseNoExt}.webp`);
  if (row.avif_url) keys.add(`${baseNoExt}.avif`);
  if (row.original_url) {
    // Original ext is unknown from here — derive it from the URL.
    const m = row.original_url.match(/\.([a-z0-9]+)(?:\?|$)/i);
    if (m?.[1]) {
      // The kept original is stored at `${base}.original.<ext>` (a DISTINCT key
      // so a same-ext source can't overwrite the quality-controlled primary —
      // see upload-media.ts pushVariant). The previous reconstruction used
      // `${base}.<ext>`, which never matched the real object — so every media
      // delete leaked its original. Mirror the upload keying exactly.
      keys.add(`${baseNoExt}.original.${m[1].toLowerCase()}`);
    }
  }
  return Array.from(keys);
}
