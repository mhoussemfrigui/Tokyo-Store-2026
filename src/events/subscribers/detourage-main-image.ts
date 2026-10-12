import "server-only";

import { asc, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { product_media } from "@/associations/product-media";
import { mediaSettingsService } from "@/modules/media/settings.service";
import { detourageProductMainImage } from "@/workflows/media/reprocess-product-white-bg";
import { bus } from "../bus";

/**
 * MAIN-image-only auto-détourage.
 *
 * When `product_white_bg` + `product_white_bg_main_only` are both on, upload-time
 * détourage is skipped (a gallery upload can't yet know which image becomes the
 * main one). Instead, when a product is saved, this removes the backdrop of just
 * its MAIN image — the first gallery image (product_media, lowest display_order).
 * Secondary/gallery shots keep their original backdrop.
 *
 * Idempotent + best-effort: detourageProductMainImage no-ops on an image already
 * détoured (`-nobg` key), a GIF, or a url_override-pinned row, and never throws.
 * Runs post-commit (the bus emit is after the product tx). A no-op unless the
 * two settings are on, so it costs nothing in the default configuration.
 */
/**
 * The product's MAIN (cover) image id — matched to the CANONICAL resolver
 * (catalog.service.ts): is_primary first, then the lowest display_order. Using
 * display_order alone would pick the wrong image when an admin marks a non-first
 * gallery image as the primary cover. Exported for the détourage test.
 */
export async function resolveProductMainMediaId(productId: string): Promise<string | null> {
  const [main] = await db
    .select({ mediaId: product_media.media_id })
    .from(product_media)
    .where(eq(product_media.product_id, productId))
    .orderBy(desc(product_media.is_primary), asc(product_media.display_order), asc(product_media.media_id))
    .limit(1);
  return main?.mediaId ?? null;
}

async function detourMainImage(productId: string, actorUserId: string | null | undefined): Promise<void> {
  const s = await mediaSettingsService.get().catch(() => null);
  if (!s || !s.product_white_bg || !s.product_white_bg_main_only) return;

  const mainMediaId = await resolveProductMainMediaId(productId);
  if (!mainMediaId) return;

  // null = system actor (the codebase convention; never the string "system").
  await detourageProductMainImage(mainMediaId, actorUserId ?? null);
}

export function registerDetourageMainImageSubscriber() {
  // Handlers are SYNCHRONOUS and DETACH the heavy détourage (S3 + sharp ×3 + DB):
  // bus.emit awaits all handlers, and product.created/updated are awaited inside
  // the product-save workflow, so awaiting here would block the operator's Save
  // response for the whole image pipeline. detourMainImage is fully try/catch-
  // wrapped + best-effort, so the detached rejection is contained (mirrors
  // reembed-product.ts, which detaches its equally-heavy embedding work).
  bus.on("product.created", ({ payload, actorUserId }) => {
    void detourMainImage(payload.productId, actorUserId).catch((err) =>
      console.error("[detourage-main-image] created failed", err),
    );
  });
  bus.on("product.updated", ({ payload, actorUserId }) => {
    // Only when the gallery actually changed (update pushes "media" to
    // changedFields) — the main image can't have changed otherwise. This also
    // prevents re-entry: the détourage's own cache-bust re-emits product.updated
    // with changedFields ["image"] (not "media"), so it never loops.
    if (!payload.changedFields?.includes("media")) return;
    void detourMainImage(payload.productId, actorUserId).catch((err) =>
      console.error("[detourage-main-image] updated failed", err),
    );
  });
}
