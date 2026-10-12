import "server-only";

import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { media, type MediaRow, type NewMediaRow } from "./schema";
import { escapeLike } from "./sql-util";
import { variantStorageKeys } from "./storage";

const MEDIA_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// UTC ISO cursor timestamp with 1–6 fractional digits (accepts both the
// microsecond form this service emits and a legacy millisecond cursor). Exported
// so a test can pin the ms↔µs back-compat contract (a tightening to \d{6} would
// silently break in-flight cross-deploy pagination).
export const MEDIA_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/;

class MediaService {
  async findById(id: string): Promise<MediaRow | null> {
    const [row] = await db
      .select()
      .from(media)
      .where(and(eq(media.id, id), isNull(media.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  async insert(input: NewMediaRow): Promise<MediaRow> {
    const [row] = await db.insert(media).values(input).returning();
    return row;
  }

  async update(
    id: string,
    patch: Partial<Omit<MediaRow, "id" | "created_at">>,
  ): Promise<MediaRow | null> {
    const [row] = await db
      .update(media)
      .set({ ...patch, updated_at: sql`now()` })
      // Exclude tombstoned rows — matches findById/list/count so update() can't
      // silently mutate a soft-deleted media.
      .where(and(eq(media.id, id), isNull(media.deleted_at)))
      .returning();
    return row ?? null;
  }

  async softDelete(id: string): Promise<void> {
    await db
      .update(media)
      .set({ deleted_at: new Date(), updated_at: sql`now()` })
      .where(eq(media.id, id));
  }

  async list(opts: {
    search?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<{ items: MediaRow[]; nextCursor: string | null }> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const conditions = [isNull(media.deleted_at)];
    if (opts.search) {
      // Match filename OR alt text so the Médiathèque search (now server-side,
      // spanning the whole library — not a client filter over the loaded page)
      // keeps the alt-text parity the old in-memory filter had.
      const like = `%${escapeLike(opts.search)}%`;
      conditions.push(or(ilike(media.filename, like), ilike(media.alt_text, like))!);
    }
    // Composite keyset cursor "<iso>__<uuid>". created_at alone isn't unique, so
    // a plain `lt(created_at)` could SKIP or DUPLICATE rows sharing a timestamp
    // at the page seam (common on bulk demo imports). id is UUID v7 (time-
    // ordered), so (created_at, id) is a stable total order matching the ORDER BY
    // below. A cursor without a valid (timestamp, UUID) pair is treated as
    // malformed and ignored (first page, never 500).
    //
    // CRITICAL: the timestamp is carried at MICROSECOND precision and compared as
    // `::timestamptz` (not via a JS Date). `created_at` is timestamptz (µs), but a
    // JS Date / `toISOString()` truncates to milliseconds — so a bulk insert whose
    // rows share `now()` at `…458413` would, after the cursor rounded to `…458`,
    // fail `created_at < cursor` for the remaining `…458413` rows and DROP them at
    // the seam. Emitting + comparing the full-precision string keeps the composite
    // cursor total order exact. `MEDIA_TS_RE` also accepts a legacy ms cursor
    // (`.458Z`) so an in-flight pagination across a deploy still parses.
    if (opts.cursor) {
      const sep = opts.cursor.lastIndexOf("__");
      const iso = sep >= 0 ? opts.cursor.slice(0, sep) : opts.cursor;
      const cursorId = sep >= 0 ? opts.cursor.slice(sep + 2) : "";
      if (MEDIA_TS_RE.test(iso) && MEDIA_UUID_RE.test(cursorId)) {
        conditions.push(sql`(${media.created_at}, ${media.id}) < (${iso}::timestamptz, ${cursorId}::uuid)`);
      }
    }

    const rows = await db
      .select({
        m: media,
        // Full-precision (µs) UTC ISO for the cursor — see the note above.
        cursorTs: sql<string>`to_char(${media.created_at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(media)
      .where(and(...conditions))
      .orderBy(desc(media.created_at), desc(media.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const trimmed = hasMore ? rows.slice(0, limit) : rows;
    const last = trimmed[trimmed.length - 1];
    return {
      items: trimmed.map((r) => r.m),
      nextCursor: hasMore && last ? `${last.cursorTs}__${last.m.id}` : null,
    };
  }

  async count(): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(media)
      .where(isNull(media.deleted_at));
    return Number(row?.value ?? 0);
  }

  /**
   * Hard-delete a set of media rows by id. Captures each row's variant
   * storage keys BEFORE deleting (the rows are gone afterwards, so the caller
   * can't recover them) and returns them alongside the deleted ids. The caller
   * MUST emit `media.bulk_deleted` with these keys so the
   * `cleanup-media-storage` subscriber purges the objects from S3 — otherwise
   * hard-deleting rows leaks their bytes in the bucket permanently.
   */
  async deleteByIds(ids: string[]): Promise<{ ids: string[]; storageKeys: string[] }> {
    if (ids.length === 0) return { ids: [], storageKeys: [] };
    // Chunk the id list so a large clear-demo sweep can't exceed Postgres's
    // 65535 bind-parameter cap on a single inArray(...). Each batch captures its
    // variant keys before deletion; the caller emits one media.bulk_deleted.
    // CHUNK MUST stay <= 65535: each inArray(batch) binds one parameter per id,
    // so a larger value would throw "too many SQL parameters" (Postgres 54001)
    // only on a big real sweep. The assertion fails the build-time tests / first
    // call instead of silently shipping a footgun if someone bumps it.
    const CHUNK = 5000;
    if (CHUNK > 60000) throw new Error("media.deleteByIds: CHUNK must stay <= 65535 (Postgres bind-param cap)");
    const storageKeys = new Set<string>();
    const deletedIds: string[] = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const batch = ids.slice(i, i + CHUNK);
      const doomed = await db
        .select({
          storage_key: media.storage_key,
          webp_url: media.webp_url,
          avif_url: media.avif_url,
          original_url: media.original_url,
        })
        .from(media)
        .where(inArray(media.id, batch));
      for (const r of doomed) for (const k of variantStorageKeys(r)) storageKeys.add(k);
      const rows = await db
        .delete(media)
        .where(inArray(media.id, batch))
        .returning({ id: media.id });
      for (const r of rows) deletedIds.push(r.id);
    }
    return { ids: deletedIds, storageKeys: Array.from(storageKeys) };
  }
}

export const mediaService = new MediaService();
