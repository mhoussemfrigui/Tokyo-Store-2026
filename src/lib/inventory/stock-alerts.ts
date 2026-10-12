import "server-only";

import { bus, type EventPayload } from "@/events/bus";
import { classifyStockCrossing, type LowStockConfig } from "@/lib/inventory/low-stock";

/**
 * Stock-CROSSING events shared by every flow that moves a tracked stock level
 * outside place-order: the admin order-line edit (claims AND releases units)
 * and the ERP/POS `/api/stock` adjustments. Mirrors place-order's inline L10
 * block (which keeps its own copy): `product.stock_low` / `product.stock_depleted`
 * on the downward crossing edge (operator reorder email, gated on the low-stock
 * toggle), and optionally `product.restocked` on a sold-out → positive crossing
 * (back-in-stock waitlist email + the restocked outbound webhook).
 *
 * The planning half is pure (no DB, no bus) so the rules are unit-testable; the
 * emit half is POST-COMMIT and best-effort — an emit hiccup never fails the
 * already-committed stock write.
 */

/** One tracked stock row's level change (before → after), with the labels the
 *  operator alert email needs. */
export type StockLevelChange = {
  productId: string;
  /** The variant whose OWN stock moved; null for a product row / shared pool. */
  variantId: string | null;
  /** Orderable reorder reference (the variant's SKU, parent SKU as fallback). */
  sku: string | null;
  name: string;
  variantLabel: string | null;
  prevQty: number;
  newQty: number;
};

export type StockCrossingEvent =
  | { name: "product.stock_depleted"; payload: EventPayload<"product.stock_depleted"> }
  | { name: "product.stock_low"; payload: EventPayload<"product.stock_low"> }
  | { name: "product.restocked"; payload: EventPayload<"product.restocked"> };

/**
 * Coalesce several moves of the SAME stock row (product + variant) into one
 * net change — first `prevQty`, last `newQty`, in first-seen order. An order
 * edit can touch one row twice in a batch (e.g. remove a line and re-add the
 * same variant); judging each move alone could raise « stock faible » then
 * « rupture » for a single edit, or a crossing the net change never made.
 */
export function mergeStockLevelChanges(changes: readonly StockLevelChange[]): StockLevelChange[] {
  const byKey = new Map<string, StockLevelChange>();
  for (const c of changes) {
    const key = `${c.productId}:${c.variantId ?? ""}`;
    const seen = byKey.get(key);
    if (seen) seen.newQty = c.newQty;
    else byKey.set(key, { ...c });
  }
  return [...byKey.values()];
}

/**
 * Pure: the crossing events a set of stock changes should raise.
 *  - low / depleted: per net change, via `classifyStockCrossing` — only when the
 *    low-stock alert feature is enabled (same gate as place-order);
 *  - restocked (opt-in): once per PRODUCT whose row went from sold out (≤ 0) to
 *    a positive level — the waitlist is product-level. Independent of the
 *    low-stock toggle (it drives the customer back-in-stock email).
 */
export function planStockCrossingEvents(
  changes: readonly StockLevelChange[],
  opts: { lowStock: LowStockConfig; restocked?: boolean },
): StockCrossingEvent[] {
  const events: StockCrossingEvent[] = [];
  const net = mergeStockLevelChanges(changes);
  if (opts.lowStock.enabled) {
    for (const c of net) {
      const crossing = classifyStockCrossing(c.prevQty, c.newQty, opts.lowStock.threshold);
      if (crossing === "depleted") {
        events.push({
          name: "product.stock_depleted",
          payload: { productId: c.productId, variantId: c.variantId, sku: c.sku, name: c.name, variantLabel: c.variantLabel },
        });
      } else if (crossing === "low") {
        events.push({
          name: "product.stock_low",
          payload: {
            productId: c.productId,
            variantId: c.variantId,
            sku: c.sku,
            name: c.name,
            variantLabel: c.variantLabel,
            currentQty: c.newQty,
            threshold: opts.lowStock.threshold,
          },
        });
      }
    }
  }
  if (opts.restocked) {
    const restocked = new Set<string>();
    for (const c of net) {
      if (c.prevQty <= 0 && c.newQty > 0) restocked.add(c.productId);
    }
    for (const productId of restocked) events.push({ name: "product.restocked", payload: { productId } });
  }
  return events;
}

/**
 * Emit the crossing events for `changes` (see planStockCrossingEvents). Call it
 * AFTER the stock write commits — a pre-commit emit could alert on a rolled-back
 * change. Best-effort: logs and swallows its own errors.
 */
export async function emitStockCrossingEvents(
  changes: readonly StockLevelChange[],
  opts: { lowStock: LowStockConfig; restocked?: boolean; actorUserId?: string | null },
): Promise<void> {
  if (changes.length === 0) return;
  const meta = { actorUserId: opts.actorUserId ?? null };
  try {
    for (const ev of planStockCrossingEvents(changes, opts)) {
      if (ev.name === "product.stock_depleted") await bus.emit(ev.name, ev.payload, meta);
      else if (ev.name === "product.stock_low") await bus.emit(ev.name, ev.payload, meta);
      else await bus.emit(ev.name, ev.payload, meta);
    }
  } catch (err) {
    console.error("[inventory] stock-crossing emit failed", err);
  }
}
