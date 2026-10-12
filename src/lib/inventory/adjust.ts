import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { isAvailable, nextInStockForQty } from "@/lib/inventory/in-stock-rule";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { stockMovementService } from "@/modules/stock-movement";
import type { StockMovementReason } from "@/modules/stock-movement";

/**
 * Atomic, race-safe stock writes for the external API (add/remove + absolute
 * set), each paired with a stock_movements ledger row IN THE SAME TX. These
 * compose correctly with the order-placement decrement (no read-modify-write
 * lost update): a DELTA is a single guarded `stock_qty = stock_qty + :d` and an
 * absolute SET captures the before/after for an honest ledger delta.
 *
 * Shared-stock resolution (variant of a shared product → parent pool) is decided
 * by the caller; this module just writes the row it's told to.
 */

export type StockTargetKind = "product" | "variant";

export type AdjustResult =
  | {
      ok: true;
      resultingQty: number | null;
      /** The row's `in_stock` AFTER the write (see in-stock-rule.ts). */
      inStock: boolean;
      /** Unavailable → available transition (drives `product.restocked`). */
      becameAvailable: boolean;
    }
  | { ok: false; code: "untracked" | "insufficient" };

type Target = {
  kind: StockTargetKind;
  rowId: string;
  /** The product id (for the ledger) — same as rowId for product targets. */
  productId: string;
  /** Variant soft-link for the ledger (null for product targets). */
  variantId?: string | null;
};

type LedgerCtx = { reason: StockMovementReason; actorUserId?: string | null; note?: string | null };

/**
 * Thrown by {@link applyStockSet} when the caller passed `expectedQty` and the
 * LOCKED committed quantity no longer matches it — i.e. the row moved (a sale, an
 * ERP sync, another operator) since the caller read it. Lets a bulk/optimistic
 * caller refuse a stale last-writer-wins clobber per row instead of resurrecting
 * already-sold units. Callers that omit `expectedQty` never see this (the ERP
 * absolute-set path stays deliberately last-writer-wins).
 */
export class StockConflictError extends Error {
  readonly code = "conflict" as const;
  constructor(
    readonly expected: number | null,
    readonly found: number | null,
  ) {
    super(
      `Stock modifié entre-temps (attendu ${expected ?? "—"}, trouvé ${found ?? "—"}). Rechargez la page puis réessayez.`,
    );
    this.name = "StockConflictError";
  }
}

/**
 * Add/remove `delta` (±N) atomically. Fails CLOSED:
 *   - untracked line (stock_qty IS NULL) → { ok:false, code:"untracked" }
 *     (an untracked line is unlimited; a delta is meaningless — caller 422s).
 *   - a negative delta that would drop below 0 → { ok:false, code:"insufficient" }.
 * On success, re-derives in_stock with the shared sold-out rule (in-stock-rule.ts):
 * a SOLD-OUT line (old qty ≤ 0) is re-listed when the new qty is positive, a
 * line reaching 0 is de-listed, and a DELIBERATELY delisted line that still has
 * units stays delisted. Logs the movement.
 */
export async function applyStockDelta(target: Target, delta: number, ctx: LedgerCtx): Promise<AdjustResult> {
  return db.transaction(async (tx) => {
    const table = target.kind === "variant" ? product_variants : products;
    const idCol = target.kind === "variant" ? product_variants.id : products.id;
    const qtyCol = target.kind === "variant" ? product_variants.stock_qty : products.stock_qty;
    const inStockCol = target.kind === "variant" ? product_variants.in_stock : products.in_stock;

    // Lock + read the pre-values first so the availability transition reported
    // to the caller (restock event) is computed from the serialized row.
    const [locked] = await tx
      .select({ q: qtyCol, inStock: inStockCol })
      .from(table)
      .where(eq(idCol, target.rowId))
      .for("update")
      .limit(1);

    // SET expressions read the OLD column values (Postgres UPDATE semantics).
    const updated = await tx
      .update(table)
      .set({
        stock_qty: sql`${qtyCol} + ${delta}`,
        in_stock: sql`CASE WHEN ${qtyCol} <= 0 THEN (${qtyCol} + ${delta}) > 0 ELSE ${inStockCol} AND (${qtyCol} + ${delta}) > 0 END`,
        updated_at: sql`now()`,
      })
      .where(and(eq(idCol, target.rowId), sql`${qtyCol} IS NOT NULL`, sql`${qtyCol} + ${delta} >= 0`))
      .returning({ stockQty: qtyCol, inStock: inStockCol });

    if (updated.length === 0) {
      // Distinguish untracked (NULL) from would-go-negative, using the locked
      // (serialized) read above rather than a torn READ COMMITTED snapshot.
      return locked && locked.q === null
        ? ({ ok: false, code: "untracked" } as const)
        : ({ ok: false, code: "insufficient" } as const);
    }

    const resultingQty = updated[0].stockQty;
    const inStock = updated[0].inStock;
    await stockMovementService.record(
      { productId: target.productId, variantId: target.variantId ?? null, delta, resultingQty, reason: ctx.reason, actorUserId: ctx.actorUserId, note: ctx.note },
      tx,
    );
    const wasAvailable = locked ? isAvailable(locked.inStock, locked.q) : false;
    return { ok: true, resultingQty, inStock, becameAvailable: !wasAvailable && isAvailable(inStock, resultingQty) };
  });
}

/**
 * Absolute set of stock_qty and/or in_stock. An absolute set is last-writer-wins
 * by design (the caller asserts "on-hand is X") — for safe incremental sync use
 * applyStockDelta. To keep it CORRECT under concurrency we lock the row FOR
 * UPDATE and read the pre-values INSIDE the tx, so the operation serializes
 * against an order decrement and the ledger delta (new − lockedOld) is honest /
 * reconcilable rather than computed from a stale pre-tx read. When `setQty` is
 * given without an explicit in_stock, in_stock is DERIVED from the locked row by
 * the shared sold-out rule (in-stock-rule.ts): an ERP quantity-only sync re-lists
 * a sold-out line (including an UNTRACKED « Rupture » line receiving its first
 * quantity > 0) / de-lists an emptied one, but never re-lists a tracked line the
 * operator deliberately delisted with units left.
 */
export async function applyStockSet(
  target: Target,
  patch: {
    setQty?: number | null;
    setInStock?: boolean;
    /**
     * Optimistic compare-and-set. When PRESENT, the write is refused with a
     * {@link StockConflictError} unless the LOCKED committed quantity equals this
     * value — so a bulk/optimistic caller can't clobber a row that moved (sale,
     * ERP sync) since it read it. Omit for deliberate last-writer-wins.
     */
    expectedQty?: number | null;
  },
  ctx: LedgerCtx,
): Promise<{ resultingQty: number | null; inStock: boolean; becameAvailable: boolean }> {
  return db.transaction(async (tx) => {
    const table = target.kind === "variant" ? product_variants : products;
    const idCol = target.kind === "variant" ? product_variants.id : products.id;
    const qtyCol = target.kind === "variant" ? product_variants.stock_qty : products.stock_qty;
    const inStockCol = target.kind === "variant" ? product_variants.in_stock : products.in_stock;

    // Lock + read the current qty so the SET serializes vs concurrent
    // decrements and the ledger delta is computed from the committed value.
    const [locked] = await tx
      .select({ q: qtyCol, inStock: inStockCol })
      .from(table)
      .where(eq(idCol, target.rowId))
      .for("update")
      .limit(1);
    const before = locked ? locked.q : null;
    const beforeInStock = locked ? locked.inStock : false;

    // Optimistic guard: refuse if the committed row moved since the caller read
    // it. Checked under the row lock and BEFORE any write, so it serializes
    // against a concurrent decrement rather than racing a stale snapshot.
    if ("expectedQty" in patch && before !== patch.expectedQty) {
      throw new StockConflictError(patch.expectedQty ?? null, before);
    }

    const set: Record<string, unknown> = { updated_at: sql`now()` };
    let resultingQty: number | null = before;
    let inStock = beforeInStock;
    if ("setQty" in patch) {
      set.stock_qty = patch.setQty;
      resultingQty = patch.setQty ?? null;
      if (patch.setInStock === undefined) {
        inStock = nextInStockForQty(before, beforeInStock, resultingQty);
        set.in_stock = inStock;
      }
    }
    if (patch.setInStock !== undefined) {
      inStock = patch.setInStock;
      set.in_stock = inStock;
    }

    await tx.update(table).set(set).where(eq(idCol, target.rowId));

    if ("setQty" in patch) {
      const after = patch.setQty ?? null;
      // Only ledger an ACTUAL quantity change. A no-op set — e.g. the bulk stock
      // page re-saving a row where only in_stock changed, or an ERP api_set to
      // the same value — must not append a spurious delta:0 row that
      // a reconciliation reader then has to filter out. (in_stock-only flips were
      // never ledgered anyway; the ledger tracks quantity.)
      if (before !== after) {
        const delta = typeof before === "number" && typeof after === "number" ? after - before : 0;
        await stockMovementService.record(
          { productId: target.productId, variantId: target.variantId ?? null, delta, resultingQty: after, reason: ctx.reason, actorUserId: ctx.actorUserId, note: ctx.note },
          tx,
        );
      }
    }
    const wasAvailable = locked ? isAvailable(beforeInStock, before) : false;
    return { resultingQty, inStock, becameAvailable: !wasAvailable && isAvailable(inStock, resultingQty) };
  });
}
