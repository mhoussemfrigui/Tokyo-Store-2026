import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { DEMO_IMAGES, type DemoImageKey } from "@/lib/demo/data";
import type { DataJobResult } from "@/modules/import";
import { uploadMediaWorkflow } from "@/workflows/media/upload-media";

/**
 * Shared demo image uploader for the segmented seed functions.
 *
 * Lifted verbatim from `import-demo.ts`'s `makeImageUploader` so the seed
 * segments (`seedBanners`, `seedBrands`, …) handle `public/demo-assets/*`
 * images exactly as the original monolithic demo import did — same media
 * pipeline (WebP/AVIF variants per `media_settings`), same per-run cache so
 * an image reused by two entities only uploads once.
 *
 * The only difference vs the original is the counter sink: instead of a
 * bespoke `ImportCounts`, increments land on the generic `DataJobResult`
 * (`mediaCreated` / `mediaFailed`, with failures pushed to `warnings`). The
 * `uploadByKey` flavour is the one the chrome seeds use; remote-URL imports
 * are handled by the product feed runner's own SSRF-hardened importer, not
 * this helper.
 */

const DEMO_IMAGES_DIR = path.join(process.cwd(), "public", "demo-assets");

export type ImageUploader = {
  uploadByKey: (
    key: DemoImageKey,
    scope: "products" | "cms" | "brands",
  ) => Promise<string | null>;
  /**
   * Upload a bundled `public/demo-assets/<filename>` by its literal filename
   * (not a `DEMO_IMAGES` key). Used by the content-snapshot seed, whose image
   * manifest carries logical stems resolved to a real file by the caller. Same
   * per-run cache + counter sink as `uploadByKey`.
   */
  uploadByFile: (
    filename: string,
    scope: "products" | "cms" | "brands",
    altText?: string,
  ) => Promise<string | null>;
};

/** Map a bundled image's extension to its MIME type (webp/avif in addition to
 *  the png/jpeg `uploadByKey` handles, since the content snapshot ships both). */
function mimeForFilename(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "avif") return "image/avif";
  return "image/jpeg";
}

export function makeImageUploader(
  actorUserId: string,
  result: DataJobResult,
): ImageUploader {
  const cache = new Map<string, string>();

  async function uploadBuffer(
    buffer: Buffer,
    filename: string,
    mimeType: string,
    cacheKey: string,
    scope: "products" | "cms" | "brands",
    altText: string,
  ): Promise<string | null> {
    const file = new File([new Uint8Array(buffer)], filename, { type: mimeType });
    const res = await uploadMediaWorkflow({
      file,
      scope,
      altText,
      uploadedBy: actorUserId,
    });
    if (!res.ok) {
      result.mediaFailed += 1;
      result.warnings.push(`upload failed for ${filename}: ${res.message}`);
      return null;
    }
    result.mediaCreated += 1;
    cache.set(cacheKey, res.data.mediaId);
    return res.data.mediaId;
  }

  async function uploadByKey(
    key: DemoImageKey,
    scope: "products" | "cms" | "brands",
  ): Promise<string | null> {
    const cacheKey = `key:${key}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const filename = DEMO_IMAGES[key];
    let buffer: Buffer;
    try {
      buffer = await readFile(path.join(DEMO_IMAGES_DIR, filename));
    } catch (err) {
      result.warnings.push(
        `image '${filename}' missing — check public/demo-assets/ shipped in the image`,
      );
      console.error("[data.seed] missing demo image", filename, err);
      return null;
    }

    const mimeType = filename.endsWith(".png") ? "image/png" : "image/jpeg";
    return uploadBuffer(buffer, filename, mimeType, cacheKey, scope, `Demo ${key}`);
  }

  async function uploadByFile(
    filename: string,
    scope: "products" | "cms" | "brands",
    altText?: string,
  ): Promise<string | null> {
    const cacheKey = `file:${filename}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    let buffer: Buffer;
    try {
      buffer = await readFile(path.join(DEMO_IMAGES_DIR, filename));
    } catch (err) {
      result.warnings.push(
        `image '${filename}' missing — check public/demo-assets/ shipped in the image`,
      );
      console.error("[data.seed] missing bundled image", filename, err);
      return null;
    }

    return uploadBuffer(
      buffer,
      filename,
      mimeForFilename(filename),
      cacheKey,
      scope,
      altText ?? filename.replace(/\.[a-z0-9]+$/i, ""),
    );
  }

  return { uploadByKey, uploadByFile };
}
