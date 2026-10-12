import "server-only";

import { and, desc, sql, type SQL } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { parseIncrementalCursor, UUID_RE } from "@/lib/api/cursor";
import { keysetCursor } from "@/lib/api/keyset";
import { orders, type OrderRow } from "./schema";

/**
 * One keyset page of orders for the admin CSV export (/admin/orders/export),
 * newest first. A DEDICATED reader instead of `orderService.list`: that one is
 * the paginated UI list — clamped at 100 rows (asking it for 1000 silently
 * returned 100) and paged on a millisecond `created_at`-only cursor, which can
 * skip orders sharing the boundary row's millisecond. This one walks the
 * `(created_at, id)` DESC keyset with a µs-faithful cursor (`<ts>|<id>`, the same
 * shape as `customerService.list`), so `collectKeysetPages` can walk it to the
 * export ceiling without losing or repeating a row. A malformed cursor is
 * ignored (first page) rather than cast into a 22007/22P02.
 */
export async function listOrdersForExport(
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ items: OrderRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 500);
  const conditions: SQL[] = [];
  if (opts.cursor) {
    const sep = opts.cursor.lastIndexOf("|");
    const curTs = sep >= 0 ? opts.cursor.slice(0, sep) : opts.cursor;
    const curId = sep >= 0 ? opts.cursor.slice(sep + 1) : undefined;
    const ts = parseIncrementalCursor(new URLSearchParams({ since: curTs }));
    if (ts.ok && ts.sinceIso && (curId === undefined || UUID_RE.test(curId))) {
      conditions.push(
        curId
          ? sql`(${orders.created_at} < ${ts.sinceIso}::timestamptz OR (${orders.created_at} = ${ts.sinceIso}::timestamptz AND ${orders.id} < ${curId}::uuid))`
          : sql`${orders.created_at} < ${ts.sinceIso}::timestamptz`,
      );
    }
  }

  const rows = await db
    .select({ row: orders, cursor: keysetCursor(orders.created_at) })
    .from(orders)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(orders.created_at), desc(orders.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const trimmed = hasMore ? rows.slice(0, limit) : rows;
  const last = trimmed[trimmed.length - 1];
  return {
    items: trimmed.map((r) => r.row),
    nextCursor: hasMore && last ? `${last.cursor}|${last.row.id}` : null,
  };
}
