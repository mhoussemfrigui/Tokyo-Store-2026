import "server-only";

import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { bus } from "@/events/bus";
import type { TransferEventItem } from "@/events/types";
import { resolveSharedStockProductIds } from "@/lib/inventory/variant-stock";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { stockLocationService } from "@/modules/stock-location";
import { stock_locations } from "@/modules/stock-location/schema";
import {
  stock_transfers,
  stock_transfer_items,
  TRANSFER_TERMINAL,
  type StockTransferRow,
  type TransferSource,
  type TransferStatus,
} from "./schema";

/** One line of a transfer to create. */
export type TransferItemInput = {
  productId: string;
  variantId?: string | null;
  qty: number;
};

/** Default page size for the Transferts list (server-side pagination). */
export const TRANSFERS_PAGE_SIZE = 20;

/**
 * Which status a transfer may move to from its current one. Cancellation is
 * allowed from any non-terminal state; the forward path is linear
 * requested → accepted → in_transit → completed. Completion is the only
 * transition that MOVES stock (see `transition`).
 */
const ALLOWED_TRANSITIONS: Record<TransferStatus, readonly TransferStatus[]> = {
  requested: ["accepted", "cancelled"],
  accepted: ["in_transit", "cancelled"],
  in_transit: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/** Internal — the transition graph guard used by transition(). */
function canTransition(from: TransferStatus, to: TransferStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The timestamp column stamped when a transfer ENTERS each status. */
const STATUS_STAMP: Partial<Record<TransferStatus, "accepted_at" | "dispatched_at" | "completed_at" | "cancelled_at">> =
  {
    accepted: "accepted_at",
    in_transit: "dispatched_at",
    completed: "completed_at",
    cancelled: "cancelled_at",
  };

export type TransferListItem = StockTransferRow & {
  fromName: string | null;
  toName: string | null;
  itemCount: number;
  totalQty: number;
};

export type TransferDetailItem = {
  id: string;
  productId: string;
  variantId: string | null;
  qty: number;
  productName: string;
  productSlug: string;
  variantLabel: string | null;
};

export type TransferDetail = StockTransferRow & {
  fromName: string | null;
  toName: string | null;
  items: TransferDetailItem[];
};

/**
 * Inter-location stock transfers. Data + lifecycle: a transfer is created
 * "requested" and walks requested → accepted → in_transit → completed (or
 * → cancelled). Only completion moves physical stock — via
 * stockLocationService.moveStockTx per item, all in ONE tx so a multi-item
 * receive is all-or-nothing. Guards + events + revalidation live in the actions
 * layer (mirrors stockLocationService ↔ stock-locations actions).
 */
class StockTransferService {
  /** Create a transfer (status "requested") + its items in one tx. */
  async create(input: {
    fromLocationId: string;
    toLocationId: string;
    items: TransferItemInput[];
    source?: TransferSource;
    orderId?: string | null;
    note?: string | null;
    requestedBy?: string | null;
  }): Promise<StockTransferRow> {
    if (input.fromLocationId === input.toLocationId) {
      throw new Error("La source et la destination doivent être différentes.");
    }
    const items = input.items
      .map((it) => ({
        productId: it.productId,
        variantId: it.variantId ?? null,
        qty: Math.max(0, Math.floor(Number(it.qty) || 0)),
      }))
      .filter((it) => it.qty > 0);
    if (items.length === 0) throw new Error("Un transfert doit contenir au moins une ligne (quantité > 0).");

    // Every line must reference a real product, and a variant line's variant must
    // belong to that product — otherwise the row is un-completable (moveStockTx
    // would move a phantom level that no total tracks). Validated up-front in one
    // batched read so create fails cleanly rather than leaving a stuck transfer.
    await this.assertLinesResolve(items);

    const transfer = await db.transaction(async (tx) => {
      const [t] = await tx
        .insert(stock_transfers)
        // `ref` is filled by its DB sequence default (stock_transfer_ref_seq).
        .values({
          from_location_id: input.fromLocationId,
          to_location_id: input.toLocationId,
          status: "requested",
          source: input.source ?? "manual",
          order_id: input.orderId ?? null,
          note: input.note ?? null,
          requested_by: input.requestedBy ?? null,
        })
        .returning();
      await tx.insert(stock_transfer_items).values(
        items.map((it) => ({
          transfer_id: t.id,
          product_id: it.productId,
          variant_id: it.variantId,
          qty: it.qty,
        })),
      );
      return t;
    });

    // Lifecycle event fired HERE (in the service), so EVERY caller — the manual
    // action, the order-driven auto-request, an ERP sync — announces a requested
    // transfer for outbound ERP webhooks + the ops notification. Post-commit,
    // best-effort (enrichment read failure must not fail the created transfer).
    const keys = await this.buildTransferKeys(input.fromLocationId, input.toLocationId, items).catch(() => null);
    await bus
      .emit(
        "stock.transfer.requested",
        {
          transferId: transfer.id,
          ref: transfer.ref,
          fromLocationId: transfer.from_location_id,
          toLocationId: transfer.to_location_id,
          fromCode: keys?.fromCode ?? null,
          toCode: keys?.toCode ?? null,
          orderId: transfer.order_id,
          source: transfer.source,
          itemCount: items.length,
          totalQty: items.reduce((s, it) => s + it.qty, 0),
          items: keys?.items ?? [],
        },
        { actorUserId: input.requestedBy ?? null },
      )
      .catch(() => {});
    return transfer;
  }

  /**
   * Resolve the ERP-facing keys for a set of transfer lines — location codes +
   * per-line sku/external_ref — so stock.transfer.* webhooks carry stable
   * identifiers an external ERP can key on, not just internal UUIDs. Best-effort
   * enrichment for the (post-commit) emit; three small batched reads.
   */
  private async buildTransferKeys(
    fromLocationId: string,
    toLocationId: string,
    lines: Array<{ productId: string; variantId: string | null; qty: number }>,
  ): Promise<{ fromCode: string | null; toCode: string | null; items: TransferEventItem[] }> {
    const locRows = await db
      .select({ id: stock_locations.id, code: stock_locations.code })
      .from(stock_locations)
      .where(inArray(stock_locations.id, [fromLocationId, toLocationId]));
    const codeById = new Map(locRows.map((l) => [l.id, l.code]));

    const productIds = [...new Set(lines.map((l) => l.productId))];
    const variantIds = [...new Set(lines.map((l) => l.variantId).filter((v): v is string => v !== null))];
    const prodRows = productIds.length
      ? await db
          .select({ id: products.id, sku: products.sku, externalRef: products.external_ref })
          .from(products)
          .where(inArray(products.id, productIds))
      : [];
    const prodById = new Map(prodRows.map((p) => [p.id, p]));
    const varRows = variantIds.length
      ? await db
          .select({ id: product_variants.id, sku: product_variants.sku })
          .from(product_variants)
          .where(inArray(product_variants.id, variantIds))
      : [];
    const varSkuById = new Map(varRows.map((v) => [v.id, v.sku]));

    const items: TransferEventItem[] = lines.map((l) => {
      const p = prodById.get(l.productId);
      const variantSku = l.variantId ? (varSkuById.get(l.variantId) ?? null) : null;
      return {
        productId: l.productId,
        variantId: l.variantId,
        sku: variantSku ?? p?.sku ?? null,
        externalRef: p?.externalRef ?? null,
        qty: l.qty,
      };
    });
    return {
      fromCode: codeById.get(fromLocationId) ?? null,
      toCode: codeById.get(toLocationId) ?? null,
      items,
    };
  }

  /**
   * Validate every line references a live product and — for a variant line — a
   * variant that belongs to that product. Two batched reads; throws a French
   * message on the first offending line. Called before create() opens its tx.
   */
  private async assertLinesResolve(items: Array<{ productId: string; variantId: string | null }>): Promise<void> {
    const productIds = [...new Set(items.map((it) => it.productId))];
    const variantIds = [...new Set(items.map((it) => it.variantId).filter((v): v is string => v !== null))];

    const prodRows = await db
      .select({ id: products.id, type: products.product_type })
      .from(products)
      .where(and(inArray(products.id, productIds), isNull(products.deleted_at)));
    const liveProducts = new Set(prodRows.map((r) => r.id));
    for (const it of items) {
      if (!liveProducts.has(it.productId)) throw new Error("Produit introuvable pour une ligne du transfert.");
    }

    // Variant ownership: a variant line's variant must belong to its product.
    if (variantIds.length > 0) {
      const varRows = await db
        .select({ id: product_variants.id, productId: product_variants.product_id })
        .from(product_variants)
        .where(and(inArray(product_variants.id, variantIds), isNull(product_variants.deleted_at)));
      const variantOwner = new Map(varRows.map((r) => [r.id, r.productId]));
      for (const it of items) {
        if (it.variantId === null) continue;
        const owner = variantOwner.get(it.variantId);
        if (!owner) throw new Error("Variante introuvable pour une ligne du transfert.");
        if (owner !== it.productId) throw new Error("Une variante ne correspond pas à son produit.");
      }
    }

    // Shared-variant GRAIN: physical stock lives in the POOL level (variantId
    // null) for a simple/shared-variable product, and in the PER-VARIANT level
    // for a per-variant variable product. A line at the wrong grain points at a
    // level that is always 0, so the transfer can never complete (moveStockTx
    // → "Stock source insuffisant"). Enforce the grain HERE so no caller — the
    // manual form, the order-driven auto-request, a future ERP sync — can create
    // a stuck transfer. (The auto path already sends the right grain via
    // normalizePlanLines; this is the belt-and-suspenders for the others.)
    const variableIds = new Set(prodRows.filter((r) => r.type === "variable").map((r) => r.id));
    if (variableIds.size > 0) {
      const sharedIds = await resolveSharedStockProductIds([...variableIds]);
      for (const it of items) {
        if (!variableIds.has(it.productId)) continue; // simple → pool line, fine
        const perVariant = !sharedIds.has(it.productId);
        if (perVariant && it.variantId === null) {
          throw new Error("Choisissez une variante : ce produit gère son stock par variante.");
        }
        if (!perVariant && it.variantId !== null) {
          throw new Error("Ce produit gère un stock partagé : transférez-le au niveau produit (sans variante).");
        }
      }
    }
  }

  /** Paginated transfer list (newest first), optionally filtered by status. */
  async list(
    opts: { status?: TransferStatus; page?: number; pageSize?: number } = {},
  ): Promise<{ items: TransferListItem[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 25, 1), 100);
    const conds = [isNull(stock_transfers.deleted_at)];
    if (opts.status) conds.push(eq(stock_transfers.status, opts.status));
    const where = and(...conds);

    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(stock_transfers)
      .where(where);

    const rows = await db
      .select()
      .from(stock_transfers)
      .where(where)
      .orderBy(desc(stock_transfers.created_at), desc(stock_transfers.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return { items: await this.enrich(rows), total: Number(n) || 0, page, pageSize };
  }

  /** Non-deleted transfer count per status — for the Transferts filter chips +
   *  the "en cours" hint, accurate across ALL pages (one grouped query). */
  async countsByStatus(): Promise<Record<TransferStatus, number>> {
    const rows = await db
      .select({ status: stock_transfers.status, n: sql<number>`count(*)::int` })
      .from(stock_transfers)
      .where(isNull(stock_transfers.deleted_at))
      .groupBy(stock_transfers.status);
    const out: Record<TransferStatus, number> = {
      requested: 0,
      accepted: 0,
      in_transit: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const r of rows) {
      if (r.status in out) out[r.status as TransferStatus] = Number(r.n) || 0;
    }
    return out;
  }

  /**
   * INCOMING (in-transit) units per DESTINATION location for a set of products —
   * the sum of NON-TERMINAL transfer items (requested/accepted/in_transit) landing
   * at each location. Keyed `${productId}:${variantId ?? ""}:${locationId}` → qty.
   * Drives the Stock matrix's « en transit » indicator so the operator sees what is
   * ARRIVING on top of the physical on-hand (the units haven't moved yet —
   * completion relocates them — so they are shown separately, never added to the level).
   */
  async incomingByLocationForProducts(productIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (productIds.length === 0) return out;
    const rows = await db
      .select({
        productId: stock_transfer_items.product_id,
        variantId: stock_transfer_items.variant_id,
        locationId: stock_transfers.to_location_id,
        qty: sql<number>`sum(${stock_transfer_items.qty})::int`,
      })
      .from(stock_transfer_items)
      .innerJoin(stock_transfers, eq(stock_transfer_items.transfer_id, stock_transfers.id))
      .where(
        and(
          inArray(stock_transfer_items.product_id, productIds),
          inArray(stock_transfers.status, ["requested", "accepted", "in_transit"]),
          isNull(stock_transfers.deleted_at),
        ),
      )
      .groupBy(stock_transfer_items.product_id, stock_transfer_items.variant_id, stock_transfers.to_location_id);
    for (const r of rows) {
      out.set(`${r.productId}:${r.variantId ?? ""}:${r.locationId}`, Number(r.qty) || 0);
    }
    return out;
  }

  /**
   * How many NON-TERMINAL transfers reference this location (as source OR
   * destination). Used to refuse deactivating/deleting a location that still has
   * pending transfers — a completion moves stock through an ACTIVE location, so a
   * deactivation would strand them (moveStockTx throws "inactif" on réception).
   */
  async countPendingForLocation(locationId: string): Promise<number> {
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(stock_transfers)
      .where(
        and(
          isNull(stock_transfers.deleted_at),
          notInArray(stock_transfers.status, [...TRANSFER_TERMINAL]),
          or(eq(stock_transfers.from_location_id, locationId), eq(stock_transfers.to_location_id, locationId)),
        ),
      );
    return Number(n) || 0;
  }

  /** Every transfer linked to an order (newest first) — for the order's admin
   *  page. Small list (an order rarely spawns more than a couple of transfers). */
  async listForOrder(orderId: string): Promise<TransferListItem[]> {
    const rows = await db
      .select()
      .from(stock_transfers)
      .where(and(eq(stock_transfers.order_id, orderId), isNull(stock_transfers.deleted_at)))
      .orderBy(desc(stock_transfers.created_at), desc(stock_transfers.id));
    return this.enrich(rows);
  }

  /** Attach location names + per-transfer item aggregates to raw transfer rows. */
  private async enrich(rows: StockTransferRow[]): Promise<TransferListItem[]> {
    if (rows.length === 0) return [];
    const locIds = [...new Set(rows.flatMap((r) => [r.from_location_id, r.to_location_id]))];
    const locs = await db
      .select({ id: stock_locations.id, name: stock_locations.name })
      .from(stock_locations)
      .where(inArray(stock_locations.id, locIds));
    const nameById = new Map(locs.map((l) => [l.id, l.name]));

    const aggs = await db
      .select({
        transferId: stock_transfer_items.transfer_id,
        itemCount: sql<number>`count(*)::int`,
        totalQty: sql<number>`coalesce(sum(${stock_transfer_items.qty}), 0)::int`,
      })
      .from(stock_transfer_items)
      .where(inArray(stock_transfer_items.transfer_id, rows.map((r) => r.id)))
      .groupBy(stock_transfer_items.transfer_id);
    const aggById = new Map(aggs.map((a) => [a.transferId, a]));

    return rows.map((r) => ({
      ...r,
      fromName: nameById.get(r.from_location_id) ?? null,
      toName: nameById.get(r.to_location_id) ?? null,
      itemCount: Number(aggById.get(r.id)?.itemCount ?? 0),
      totalQty: Number(aggById.get(r.id)?.totalQty ?? 0),
    }));
  }

  /** One transfer with its resolved line items + location names. */
  async getById(id: string): Promise<TransferDetail | null> {
    const [row] = await db
      .select()
      .from(stock_transfers)
      .where(and(eq(stock_transfers.id, id), isNull(stock_transfers.deleted_at)))
      .limit(1);
    if (!row) return null;

    const locs = await db
      .select({ id: stock_locations.id, name: stock_locations.name })
      .from(stock_locations)
      .where(inArray(stock_locations.id, [row.from_location_id, row.to_location_id]));
    const nameById = new Map(locs.map((l) => [l.id, l.name]));

    const itemRows = await db
      .select({
        id: stock_transfer_items.id,
        productId: stock_transfer_items.product_id,
        variantId: stock_transfer_items.variant_id,
        qty: stock_transfer_items.qty,
        productName: products.name,
        productSlug: products.slug,
        variantLabel: product_variants.label,
      })
      .from(stock_transfer_items)
      .leftJoin(products, eq(products.id, stock_transfer_items.product_id))
      .leftJoin(product_variants, eq(product_variants.id, stock_transfer_items.variant_id))
      .where(eq(stock_transfer_items.transfer_id, id));

    return {
      ...row,
      fromName: nameById.get(row.from_location_id) ?? null,
      toName: nameById.get(row.to_location_id) ?? null,
      items: itemRows.map((it) => ({
        id: it.id,
        productId: it.productId,
        variantId: it.variantId,
        qty: it.qty,
        productName: it.productName ?? "(produit supprimé)",
        productSlug: it.productSlug ?? "",
        variantLabel: it.variantLabel,
      })),
    };
  }

  /**
   * Move a transfer to `to`, enforcing the allowed transitions. Completion moves
   * every line's stock (source → destination) in the SAME tx as the status flip,
   * so a receive is atomic and can't be marked done while a line's stock failed
   * to move. Returns the updated row + the distinct product ids the move touched
   * (for the caller to bust caches). A no-op / illegal transition throws.
   */
  async transition(
    id: string,
    to: TransferStatus,
    ctx: { actorUserId?: string | null; cancelReason?: string | null } = {},
  ): Promise<{ row: StockTransferRow; touchedProductIds: string[] }> {
    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(stock_transfers)
        .where(and(eq(stock_transfers.id, id), isNull(stock_transfers.deleted_at)))
        .for("update");
      if (!current) throw new Error("Transfert introuvable.");
      const from = current.status as TransferStatus;
      if (TRANSFER_TERMINAL.includes(from)) throw new Error("Ce transfert est déjà clôturé.");
      if (!canTransition(from, to)) {
        throw new Error(`Transition non autorisée (${from} → ${to}).`);
      }

      let touchedProductIds: string[] = [];
      let completedLines: Array<{ productId: string; variantId: string | null; qty: number }> = [];
      if (to === "completed") {
        // Deterministic (product, variant) order so two concurrent completions
        // sharing products lock the TOTAL rows in ONE global order — no ABBA
        // deadlock (mirrors setLocationActive / evacuateLocation).
        const items = await tx
          .select()
          .from(stock_transfer_items)
          .where(eq(stock_transfer_items.transfer_id, id))
          .orderBy(asc(stock_transfer_items.product_id), asc(stock_transfer_items.variant_id));
        const note = `Transfert TR-${current.ref}`;
        for (const it of items) {
          await stockLocationService.moveStockTx(
            tx,
            { productId: it.product_id, variantId: it.variant_id },
            current.from_location_id,
            current.to_location_id,
            it.qty,
            { actorUserId: ctx.actorUserId ?? null, orderId: current.order_id, note },
          );
        }
        touchedProductIds = [...new Set(items.map((it) => it.product_id))];
        completedLines = items.map((it) => ({ productId: it.product_id, variantId: it.variant_id, qty: it.qty }));
      }

      const stampCol = STATUS_STAMP[to];
      const [row] = await tx
        .update(stock_transfers)
        .set({
          status: to,
          updated_at: sql`now()`,
          ...(stampCol ? { [stampCol]: sql`now()` } : {}),
          ...(to === "cancelled" ? { cancel_reason: ctx.cancelReason ?? null } : {}),
        })
        .where(eq(stock_transfers.id, id))
        .returning();
      return { row, touchedProductIds, completedLines };
    });

    // Lifecycle events fired HERE (post-commit) so EVERY caller announces —
    // including the order-cancel cascade (cancelPendingForOrder) which calls
    // transition() directly, not via the action. Best-effort.
    const { row } = result;
    if (to === "completed") {
      const keys = await this.buildTransferKeys(row.from_location_id, row.to_location_id, result.completedLines).catch(
        () => null,
      );
      await bus
        .emit(
          "stock.transfer.completed",
          {
            transferId: row.id,
            ref: row.ref,
            fromLocationId: row.from_location_id,
            toLocationId: row.to_location_id,
            fromCode: keys?.fromCode ?? null,
            toCode: keys?.toCode ?? null,
            orderId: row.order_id,
            productIds: result.touchedProductIds,
            items: keys?.items ?? [],
          },
          { actorUserId: ctx.actorUserId ?? null },
        )
        .catch(() => {});
    } else if (to === "cancelled") {
      await bus
        .emit(
          "stock.transfer.cancelled",
          { transferId: row.id, ref: row.ref, orderId: row.order_id },
          { actorUserId: ctx.actorUserId ?? null },
        )
        .catch(() => {});
    } else if (to === "accepted") {
      // Source acknowledged (no stock moved yet) — codes only, no item payload.
      const keys = await this.buildTransferKeys(row.from_location_id, row.to_location_id, []).catch(() => null);
      await bus
        .emit(
          "stock.transfer.accepted",
          {
            transferId: row.id,
            ref: row.ref,
            fromLocationId: row.from_location_id,
            toLocationId: row.to_location_id,
            fromCode: keys?.fromCode ?? null,
            toCode: keys?.toCode ?? null,
            orderId: row.order_id,
          },
          { actorUserId: ctx.actorUserId ?? null },
        )
        .catch(() => {});
    } else if (to === "in_transit") {
      // DISPATCHED — goods left the source. Carry the moving lines so an ERP can
      // record the IN-TRANSIT leg (outgoing at source / incoming at destination)
      // before completion relocates the levels.
      const itemRows = await db
        .select({
          product_id: stock_transfer_items.product_id,
          variant_id: stock_transfer_items.variant_id,
          qty: stock_transfer_items.qty,
        })
        .from(stock_transfer_items)
        .where(eq(stock_transfer_items.transfer_id, row.id))
        .catch(() => [] as Array<{ product_id: string; variant_id: string | null; qty: number }>);
      const lines = itemRows.map((it) => ({ productId: it.product_id, variantId: it.variant_id, qty: it.qty }));
      const keys = await this.buildTransferKeys(row.from_location_id, row.to_location_id, lines).catch(() => null);
      await bus
        .emit(
          "stock.transfer.dispatched",
          {
            transferId: row.id,
            ref: row.ref,
            fromLocationId: row.from_location_id,
            toLocationId: row.to_location_id,
            fromCode: keys?.fromCode ?? null,
            toCode: keys?.toCode ?? null,
            orderId: row.order_id,
            items: keys?.items ?? [],
          },
          { actorUserId: ctx.actorUserId ?? null },
        )
        .catch(() => {});
    }
    return result;
  }

  /**
   * Cancel every NON-TERMINAL transfer linked to an order — used when the order
   * is cancelled, so its store→depot replenishment requests don't linger. A
   * transfer that already completed keeps its moved stock (the goods physically
   * changed store); only requested/accepted/in_transit ones are cancelled.
   * Best-effort per transfer (a concurrent completion just gets skipped).
   */
  async cancelPendingForOrder(
    orderId: string,
    ctx: { actorUserId?: string | null; reason?: string | null } = {},
  ): Promise<{ cancelled: number }> {
    const rows = await db
      .select({ id: stock_transfers.id })
      .from(stock_transfers)
      .where(
        and(
          eq(stock_transfers.order_id, orderId),
          isNull(stock_transfers.deleted_at),
          notInArray(stock_transfers.status, [...TRANSFER_TERMINAL]),
        ),
      );
    let cancelled = 0;
    for (const r of rows) {
      try {
        await this.transition(r.id, "cancelled", {
          actorUserId: ctx.actorUserId ?? null,
          cancelReason: ctx.reason ?? "Commande annulée",
        });
        cancelled++;
      } catch {
        // Already terminal / raced to completion — skip.
      }
    }
    return { cancelled };
  }
}

export const stockTransferService = new StockTransferService();
