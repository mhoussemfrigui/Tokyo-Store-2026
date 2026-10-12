import { type TransferSourcingStrategy } from "@/lib/inventory/locations-config";

/**
 * PURE auto-transfer planner (no server / DB deps, so it unit-tests in the pure
 * chain). Given the ordered lines + the per-location stock, it decides which
 * store→depot transfers to raise so the selling depot can fulfil the order. See
 * autoRequestTransfersForOrder (auto-transfer.ts) for the DB-backed caller.
 */

/** The per-location level key used by stockLocationService.listLevelsForProducts. */
export function levelKey(productId: string, variantId: string | null): string {
  return variantId ? `${productId}:${variantId}` : productId;
}

export type PlanItem = { productId: string; variantId: string | null; quantity: number };
export type SourceLoc = { id: string; displayOrder: number };

/**
 * Normalise ordered lines to their physical-stock keys before planning: a line
 * of a SHARED-stock product (id in `sharedProductIds`) has no per-variant level —
 * its stock lives in the product POOL, so redirect it to variantId null (exactly
 * where placement decremented + where ship-depot-decrement drops it). Redirecting
 * can collapse two variants of one shared product onto the same key, so merge by
 * (productId, variantId) and sum the quantities — the depot shortfall for the pool
 * is then computed once. Pure; the DB-backed caller resolves `sharedProductIds`.
 */
export function normalizePlanLines(
  lines: Array<{ productId: string; variantId: string | null; quantity: number }>,
  sharedProductIds: ReadonlySet<string>,
): PlanItem[] {
  const byKey = new Map<string, PlanItem>();
  for (const it of lines) {
    const variantId = sharedProductIds.has(it.productId) ? null : (it.variantId ?? null);
    const key = levelKey(it.productId, variantId);
    const prev = byKey.get(key);
    if (prev) prev.quantity += it.quantity;
    else byKey.set(key, { productId: it.productId, variantId, quantity: it.quantity });
  }
  return [...byKey.values()];
}
export type TransferPlan = {
  fromLocationId: string;
  items: Array<{ productId: string; variantId: string | null; qty: number }>;
};

/**
 * For each ordered line, work out how much the DEPOT is short (ordered − depot
 * level), then pick ONE source store that physically holds the item — by the
 * sourcing strategy (`priority` = the stores' display order; `most_stock` = the
 * store holding the most) — and move `min(shortfall, sourceLevel)` from it. Lines
 * are grouped into ONE transfer per source store. A line the depot can already
 * fill, or that no store holds, is skipped. Deterministic + side-effect-free.
 */
export function planAutoTransfers(input: {
  items: PlanItem[];
  depotId: string;
  sources: SourceLoc[];
  /** key (levelKey) → locationId → qty. */
  levels: Map<string, Map<string, number>>;
  sourcing: TransferSourcingStrategy;
}): TransferPlan[] {
  const bySource = new Map<string, TransferPlan["items"]>();
  for (const it of input.items) {
    if (it.quantity <= 0) continue;
    const perLoc = input.levels.get(levelKey(it.productId, it.variantId));
    const depotLevel = perLoc?.get(input.depotId) ?? 0;
    const shortfall = it.quantity - depotLevel;
    if (shortfall <= 0) continue; // depot can already ship it

    const candidates = input.sources
      .map((s) => ({ s, lvl: perLoc?.get(s.id) ?? 0 }))
      .filter((c) => c.lvl > 0);
    if (candidates.length === 0) continue; // no store holds it — leave to the operator

    candidates.sort((a, b) =>
      input.sourcing === "most_stock"
        ? b.lvl - a.lvl || a.s.displayOrder - b.s.displayOrder
        : a.s.displayOrder - b.s.displayOrder || b.lvl - a.lvl,
    );
    const chosen = candidates[0];
    const qty = Math.min(shortfall, chosen.lvl);
    const list = bySource.get(chosen.s.id) ?? [];
    list.push({ productId: it.productId, variantId: it.variantId, qty });
    bySource.set(chosen.s.id, list);
  }
  return [...bySource.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([fromLocationId, items]) => ({ fromLocationId, items }));
}
