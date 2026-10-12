import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { MAX_UPLOAD_MB_CEILING } from "./limits";
import {
  media_settings,
  SINGLETON_ID,
  type MediaSettingsRow,
} from "./settings.schema";

// Re-export so existing importers (workflows/media/settings.ts) keep working;
// the value is single-sourced in ./limits (client-safe).
export { MAX_UPLOAD_MB_CEILING };

/**
 * Media settings service — singleton with a tiny in-process cache.
 *
 * The settings row is read on every upload, so we cache it for `CACHE_TTL_MS`.
 * Any update via `mediaSettingsService.update(...)` invalidates the cache so
 * subsequent reads see the new values immediately.
 *
 * The baseline migration does not seed the row — `get()` materialises it on
 * first read via `INSERT … ON CONFLICT` with the schema defaults, so a
 * missing or wiped row never crashes the upload pipeline.
 */

const CACHE_TTL_MS = 30_000;

let cached: { value: MediaSettingsRow; expiresAt: number } | null = null;

class MediaSettingsService {
  /** Read the singleton, materialising the row if missing. */
  async get(): Promise<MediaSettingsRow> {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;

    const [row] = await db
      .select()
      .from(media_settings)
      .where(eq(media_settings.id, SINGLETON_ID))
      .limit(1);

    if (row) {
      cached = { value: row, expiresAt: now + CACHE_TTL_MS };
      return row;
    }

    // Defensive: a wiped row gets recreated with the schema defaults.
    const [seeded] = await db
      .insert(media_settings)
      .values({ id: SINGLETON_ID })
      .onConflictDoNothing()
      .returning();

    const finalRow =
      seeded ??
      (await db
        .select()
        .from(media_settings)
        .where(eq(media_settings.id, SINGLETON_ID))
        .limit(1))[0]!;

    cached = { value: finalRow, expiresAt: now + CACHE_TTL_MS };
    return finalRow;
  }

  /** Force the next `get()` to hit the DB. */
  invalidate() {
    cached = null;
  }

  /**
   * Patch the singleton. Returns the new row.
   * Caller is responsible for input sanitisation (see updateMediaSettingsAction).
   */
  async update(
    patch: Partial<
      Omit<MediaSettingsRow, "id" | "created_at" | "updated_at">
    >,
  ): Promise<MediaSettingsRow> {
    // Ensure the singleton row exists first — on a fresh DB where no get() has
    // run yet, a bare UPDATE would match 0 rows, return undefined, and the
    // caller would falsely report success. get() materialises it (ON CONFLICT).
    await this.get();
    // Clamp encoder qualities to a sane range so a typo can't produce a
    // 4-MB AVIF with quality 100, or a 200-byte unreadable JPEG with quality 0.
    if (patch.webp_quality !== undefined)
      patch.webp_quality = clamp(patch.webp_quality, 30, 100);
    if (patch.avif_quality !== undefined)
      patch.avif_quality = clamp(patch.avif_quality, 30, 100);
    if (patch.jpeg_quality !== undefined)
      patch.jpeg_quality = clamp(patch.jpeg_quality, 30, 100);
    if (patch.max_width_px !== undefined)
      patch.max_width_px = clamp(patch.max_width_px, 0, 8000);
    if (patch.max_height_px !== undefined)
      patch.max_height_px = clamp(patch.max_height_px, 0, 8000);
    if (patch.max_upload_mb !== undefined)
      patch.max_upload_mb = clamp(patch.max_upload_mb, 1, MAX_UPLOAD_MB_CEILING);

    const [row] = await db
      .update(media_settings)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(media_settings.id, SINGLETON_ID))
      .returning();

    this.invalidate();
    return row;
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

export const mediaSettingsService = new MediaSettingsService();
