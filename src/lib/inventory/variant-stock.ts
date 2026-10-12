import "server-only";

import { inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { products } from "@/modules/catalog/product/schema";

/**
 * Variant stock MODE resolution.
 *
 * A variable product's variants can either each track their own `stock_qty`
 * (PER-VARIANT, the classic mode) or all draw from the parent product's single
 * `stock_qty` pool (SHARED — "10 in stock" means 10 across every variant, for
 * when per-variant counts aren't knowable).
 *
 * The mode is a global default (app_secrets `catalog.variant_stock_shared_default`,
 * default OFF = per-variant) that each product can OVERRIDE via
 * `products.shared_variant_stock` (NULL = inherit the global default).
 *
 * The global default is read on the order hot-path (placement/cancellation), so
 * it's cached for a short TTL; the setter invalidates THIS process cache only.
 * The storefront product DTO ('use cache', lib/api/products.ts) bakes the mode
 * into every variant's inStock/stockQty, so a caller flipping it must also bust
 * the product cache tags + audit the change (see setVariantStockDefaultAction).
 */
export const VARIANT_STOCK_SHARED_DEFAULT_KEY = "catalog.variant_stock_shared_default";
const KEY = VARIANT_STOCK_SHARED_DEFAULT_KEY;
const TTL_MS = 15_000;
let cache: { value: boolean; expires: number } | null = null;
// Last value this process actually READ (or wrote) — the stale fallback when a
// refresh fails. Never expires; only a successful read/write replaces it.
let lastGood: boolean | null = null;

function parseBool(v: string | undefined): boolean {
  const t = v?.trim().toLowerCase();
  return t === "true" || t === "1" || t === "on" || t === "yes";
}

/**
 * Global default (cached). Unset → false (classic per-variant).
 *
 * Only a SUCCESSFUL read is cached. A failed read (DB hiccup, pool-acquire
 * timeout) is never mistaken for "OFF": it serves the last value this process
 * read (stale, NOT re-cached — the next call retries) and, when there is none
 * yet, THROWS. A silent `false` would flip every product inheriting a global
 * "shared" default to per-variant for the whole TTL — placement decrementing /
 * restock crediting the wrong stock row (oversold pool, lost units). The order
 * workflows (place-order, edit-items, returns, cancel, refund) resolve it
 * BEFORE opening their transaction, so a throw fails them cleanly with a
 * retryable error — and the read never takes a second pool connection mid-tx.
 */
export async function getSharedStockDefault(): Promise<boolean> {
  const now = Date.now();
  if (cache && cache.expires > now) return cache.value;
  try {
    const res = await db.execute<{ value: string }>(sql`SELECT value FROM app_secrets WHERE key = ${KEY}`);
    const value = parseBool(res.rows[0]?.value);
    cache = { value, expires: now + TTL_MS };
    lastGood = value;
    return value;
  } catch (err) {
    if (lastGood !== null) {
      console.error("[variant-stock] global default read failed — serving the last known value", err);
      return lastGood;
    }
    throw err;
  }
}

export async function setSharedStockDefault(enabled: boolean): Promise<void> {
  await db.execute(sql`
    INSERT INTO app_secrets (key, value) VALUES (${KEY}, ${enabled ? "true" : "false"})
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
  cache = null;
  lastGood = enabled;
}

/**
 * Effective shared-stock mode for a product, given the resolved global default.
 * `override` is `products.shared_variant_stock` (NULL = inherit). Pure — pass
 * the global default in so hot loops resolve it once.
 */
export function isSharedStock(override: boolean | null | undefined, globalDefault: boolean): boolean {
  return override ?? globalDefault;
}

/**
 * Of the given product ids, which are in SHARED-variant-stock mode (a variable
 * product whose variants draw from one pool). Physical stock for these lives in
 * the product POOL level ({productId, variantId:null}) — the same row placement
 * decremented — NOT per variant. Every physical-stock mover keyed on an order
 * line's variant_id (ship decrement, auto-request planning, transfer items) must
 * redirect a shared product's line to the pool, or it writes/reads a phantom
 * per-variant level the total never tracks. Resolves the global default once +
 * one batched read. Simple/non-shared variable products are absent from the set.
 */
export async function resolveSharedStockProductIds(productIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return new Set();
  const globalDefault = await getSharedStockDefault();
  const rows = await db
    .select({ id: products.id, override: products.shared_variant_stock, type: products.product_type })
    .from(products)
    .where(inArray(products.id, ids));
  const shared = new Set<string>();
  for (const r of rows) {
    if (r.type === "variable" && isSharedStock(r.override, globalDefault)) shared.add(r.id);
  }
  return shared;
}
