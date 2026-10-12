import "server-only";

import { fetchRemoteImage, RemoteImageError } from "@/lib/media/fetch-remote-image";
import { getMaxUploadBytes } from "@/modules/media/processor";
import { uploadMediaWorkflow } from "./upload-media";
import { fail, workflow } from "../shared";

/**
 * Import-from-URL workflow.
 *
 * Downloads a remote image (SSRF-hardened — see fetch-remote-image.ts), wraps
 * the bytes in a File, and hands off to the EXACT same uploadMediaWorkflow a
 * browser upload uses. So the URL-imported image gets the identical treatment:
 * EXIF strip, resize, webp/avif variant generation, S3 storage, one media row.
 * The result is a normal médiathèque entry usable anywhere by media_id.
 */
type ImportUrlInput = {
  url: string;
  scope: "products" | "categories" | "brands" | "cms" | "uploads";
  altText?: string;
  uploadedBy: string;
};

export const importMediaFromUrlWorkflow = workflow<
  [ImportUrlInput],
  { mediaId: string; url: string }
>("media.import_url", async (input) => {
  const url = (input.url ?? "").trim();
  if (!url) return fail("validation", "URL requise.");

  const maxBytes = await getMaxUploadBytes();

  let remote;
  try {
    remote = await fetchRemoteImage(url, maxBytes);
  } catch (err) {
    if (err instanceof RemoteImageError) return fail(err.code, err.message);
    if (err instanceof Error && err.name === "TimeoutError") {
      return fail("timeout", "Le téléchargement a expiré.");
    }
    console.error("[workflow:media.import_url] fetch failed", err);
    return fail("fetch_failed", "Téléchargement de l'image impossible.");
  }

  // Reuse the full upload pipeline (processImage → webp/avif → S3 → media row).
  const file = new File([new Uint8Array(remote.buffer)], remote.filename, { type: remote.mime });
  return uploadMediaWorkflow({
    file,
    scope: input.scope,
    altText: input.altText,
    uploadedBy: input.uploadedBy,
  });
});
