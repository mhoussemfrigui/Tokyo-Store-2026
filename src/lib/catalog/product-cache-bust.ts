import "server-only";

import { inArray } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";
import { bus } from "@/events/bus";

/**
 * Emit `product.updated` for every product whose STOCK changed (a sale, an admin
 * order edit, or a restock) so the catalog-cache invalidator busts their cached
 * PDP / listing reads — `products:list` + `product:<id>` + `product:slug:<slug>` —
 * and the storefront stops advertising stale stock/in_stock.
 *
 * NOT free: the cache invalidator is not the only `product.updated` subscriber.
 * Every emit (one per touched product, i.e. per order line on a sale) also runs
 * the `bus.onAny` fan-out — audit-everything writes an info-severity `audit_log`
 * row (kept even with `persist_low_signal` off), dispatch-webhooks enqueues an
 * outbound delivery for every endpoint subscribed to `product.updated` or `*`,
 * plus the metrics counter and structured logger. The re-embed subscriber also
 * listens but returns early for the stock (or image) `changedFields` sent here
 * (none is embedded text — see reembed-fields.ts). Keep emits to
 * one per product per flow. ONE batched slug lookup; a no-op for an empty id set.
 * Intended to be called POST-COMMIT and best-effort — a cache hiccup must never
 * fail the order — so it swallows its own errors.
 *
 * Single source for the place-order / edit-items / restock cache-bust so the three
 * stock-mutating flows can't drift (e.g. one of them forgetting to invalidate and
 * leaving a sold-out product cached as "in stock").
 */
export async function emitProductStockCacheBust(
  productIds: Iterable<string>,
  actorUserId: string | null = null,
  changedFields: string[] = ["stock_qty", "in_stock"],
): Promise<void> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return;
  try {
    const rows = await db
      .select({
        id: products.id,
        slug: products.slug,
        // ERP identifiers come along in the SAME batched read (no extra query per
        // product) so each enriched product.updated lets a consumer correlate the
        // stock change to its own record without a GET /api/products callback.
        sku: products.sku,
        gtin: products.gtin,
        externalRef: products.external_ref,
      })
      .from(products)
      .where(inArray(products.id, ids));
    const rowById = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const row = rowById.get(id);
      if (!row) continue;
      await bus.emit(
        "product.updated",
        {
          productId: id,
          slug: row.slug,
          changedFields,
          sku: row.sku,
          gtin: row.gtin,
          externalRef: row.externalRef,
        },
        { actorUserId },
      );
    }
  } catch (err) {
    console.error("[catalog] product cache-bust failed", err);
  }
}
