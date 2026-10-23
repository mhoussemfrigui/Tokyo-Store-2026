import "server-only";

import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";

import { db, type Tx } from "@/lib/db/client";
import { StockConflictError } from "@/lib/inventory/adjust";
import { isAvailable, nextInStockForQty } from "@/lib/inventory/in-stock-rule";
import { nextTotalForLevelWrite } from "@/lib/inventory/level-total";
import { getSharedStockDefault } from "@/lib/inventory/variant-stock";
import { products, product_variants } from "@/modules/catalog/product/schema";
import { stockMovementService, type StockMovementReason } from "@/modules/stock-movement";
import {
  stock_levels,
  stock_locations,
  type NewStockLocationRow,
  type StockLocationRow,
} from "./schema";

/** A stock target: a product pool (variantId null) or a specific variant. */
export type LevelTarget = { productId: string; variantId: string | null };

/** Internal rollback signal for setDefault (target not an active location). */
class DefaultNotPromotedError extends Error {}

/**
 * evacuateLocation failed part-way. Each line moves in its OWN transaction, so
 * the lines before the failing one stayed committed (their levels are 0 now, so
 * a retry won't reselect them). Carries what those lines changed so the caller
 * can still emit the post-commit product.updated / product.restocked. `message`
 * is the original error's.
 */
export class EvacuatePartialError extends Error {
  constructor(
    message: string,
    readonly touchedProductIds: string[],
    readonly restockedProductIds: string[],
  ) {
    super(message);
    this.name = "EvacuatePartialError";
  }
}

/**
 * Multi-location inventory service — manages stock LOCATIONS + per-location
 * LEVELS. The product/variant `stock_qty` columns stay the authoritative
 * sellable TOTAL; this service maintains them as the cached sum-of-levels while
 * letting the operator edit per-store quantities.
 */
class StockLocationService {
  /** Every non-deleted location (incl. inactive), default first. The Stock page
   *  filters this to active for the table; the Emplacements card shows them all. */
  async listAll(): Promise<StockLocationRow[]> {
    return db
      .select()
      .from(stock_locations)
      .where(isNull(stock_locations.deleted_at))
      .orderBy(sql`${stock_locations.is_default} desc`, asc(stock_locations.display_order));
  }

  async findById(id: string): Promise<StockLocationRow | null> {
    const [row] = await db
      .select()
      .from(stock_locations)
      .where(and(eq(stock_locations.id, id), isNull(stock_locations.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  /** Resolve a location by its operator/ERP `code` (the stable key an external
   *  system addresses a store by — unique over the live set). Non-deleted only;
   *  may be inactive (the caller decides whether to accept that). Used by the
   *  per-location `/api/stock` reads/writes so an ERP keys a store by its code. */
  async findByCode(code: string): Promise<StockLocationRow | null> {
    const c = code.trim();
    if (!c) return null;
    const [row] = await db
      .select()
      .from(stock_locations)
      .where(and(eq(stock_locations.code, c), isNull(stock_locations.deleted_at)))
      .limit(1);
    return row ?? null;
  }

  /** Read ONE location's on-hand for a target (product pool or variant). 0 when no
   *  level row exists yet. For the per-location `/api/stock` GET. */
  async getLocationLevel(target: LevelTarget, locationId: string): Promise<number> {
    const isVariant = target.variantId != null;
    const [row] = await db
      .select({ qty: stock_levels.qty })
      .from(stock_levels)
      .where(
        and(
          eq(stock_levels.location_id, locationId),
          eq(stock_levels.product_id, target.productId),
          isVariant ? eq(stock_levels.variant_id, target.variantId!) : isNull(stock_levels.variant_id),
        ),
      )
      .limit(1);
    return row?.qty ?? 0;
  }

  /** Total on-hand units a location still holds (across all its levels). Used to
   *  refuse deleting a location with stock — the operator must move it out (set
   *  the levels to 0, which decrements the cached totals) first. */
  async locationStockUnits(id: string): Promise<number> {
    const [row] = await db
      .select({ s: sql<number>`coalesce(sum(${stock_levels.qty}), 0)` })
      .from(stock_levels)
      .where(eq(stock_levels.location_id, id));
    return Number(row?.s ?? 0);
  }

  /** On-hand units per location (locationId → total qty across its levels), for
   *  the management screen's "contient N unités" hint + the delete guard. */
  async unitsByLocation(): Promise<Map<string, number>> {
    const rows = await db
      .select({
        locationId: stock_levels.location_id,
        s: sql<number>`coalesce(sum(${stock_levels.qty}), 0)`,
      })
      .from(stock_levels)
      .groupBy(stock_levels.location_id);
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.locationId, Number(r.s));
    return out;
  }

  /** Next display_order (max + 1) so a new location sorts after the others. */
  async nextDisplayOrder(): Promise<number> {
    const [row] = await db
      .select({ m: sql<number>`coalesce(max(${stock_locations.display_order}), 0)` })
      .from(stock_locations)
      .where(isNull(stock_locations.deleted_at));
    return Number(row?.m ?? 0) + 1;
  }

  async create(input: NewStockLocationRow): Promise<StockLocationRow> {
    const [row] = await db.insert(stock_locations).values(input).returning();
    return row;
  }

  async update(id: string, patch: Partial<NewStockLocationRow>): Promise<void> {
    await db
      .update(stock_locations)
      .set({ ...patch, updated_at: sql`now()` })
      .where(eq(stock_locations.id, id));
  }

  /** Soft-delete a location. The default location can't be deleted (guarded by
   *  the caller; here we also refuse). Its levels CASCADE on a hard delete, but
   *  a soft delete just hides it — callers should move stock out first. Returns
   *  whether a live, non-default row was actually deleted (so the caller only
   *  audits a real deletion). */
  async softDelete(id: string): Promise<boolean> {
    const rows = await db
      .update(stock_locations)
      .set({ deleted_at: sql`now()`, is_active: false, is_default: false, updated_at: sql`now()` })
      .where(
        and(
          eq(stock_locations.id, id),
          eq(stock_locations.is_default, false),
          isNull(stock_locations.deleted_at),
        ),
      )
      .returning({ id: stock_locations.id });
    return rows.length > 0;
  }

  /**
   * Reconcile the DEFAULT location's levels so that, for every tracked target,
   * the sum of its active-location levels equals the cached total
   * (`products`/`product_variants`.stock_qty). The default gets the remainder
   * after every OTHER active location, floored at 0.
   *
   * Backfill (and optionally reseed) the DEFAULT location's `stock_levels` rows
   * from the cached totals. While in shared mode, stock edits (and order
   * decrements) move `stock_qty` WITHOUT touching `stock_levels`, so a target can
   * carry a total with no default-location level.
   *
   * - Default (`overwrite` false): **backfill-only** — create MISSING default
   *   rows, never touch an existing one. Safe to call before every matrix save:
   *   a default level that diverges from the total on purpose (e.g. a web order
   *   placed but not yet shipped) is preserved. Idempotent no-op once every
   *   target is level-tracked.
   * - `overwrite: true`: also **reseed** existing default rows to
   *   `stock_qty − Σ(others)` — used ONLY on the shared → per_location switch, to
   *   realign any stale leftover levels to the totals that are the baseline then.
   *
   * Never disturbs quantities an operator has placed at NON-default locations.
   */
  async reconcileDefaultLevels(opts?: { overwrite?: boolean }): Promise<void> {
    const [def] = await db
      .select({ id: stock_locations.id })
      .from(stock_locations)
      .where(and(eq(stock_locations.is_default, true), isNull(stock_locations.deleted_at)))
      .limit(1);
    if (!def) return;
    const defId = def.id;

    // The effective shared-variant default (override ?? global) decides whether a
    // VARIABLE product's authoritative stock lives in the pool (shared) or the
    // per-variant levels. The global default isn't a DB default, so resolve it in
    // JS and interpolate. Needed by BOTH parts below, so resolve it up-front.
    const globalDefault = await getSharedStockDefault();

    // Conflict strategy. DEFAULT = backfill-only (`DO NOTHING`): only insert the
    // MISSING default rows, never overwrite an existing level — so a default
    // level that legitimately diverges from the total (an unshipped order) is
    // preserved. `overwrite: true` RESEEDS existing rows to the totals (shared →
    // per_location switch only). Overwriting on every save was the depot-clobber
    // bug; see the two call sites in src/lib/actions/stock-locations.ts.
    const conflictAction = opts?.overwrite
      ? sql`DO UPDATE SET qty = EXCLUDED.qty, updated_at = now()`
      : sql`DO NOTHING`;

    // Product pools (variant_id IS NULL): default = stock_qty − Σ(other active).
    // Gated to products whose authoritative stock IS the pool: a SIMPLE product, or
    // a SHARED-variant variable one. A genuinely per-variant VARIABLE product is
    // handled by Part 2 ONLY — without this gate, a variable product that still
    // carries a leftover non-NULL parent stock_qty (e.g. promoted simple→variable)
    // would get BOTH a pool level HERE and per-variant levels below, double-counting
    // its units in every Σ(levels) hint / guard. Mirrors Part 2's shared gate.
    //
    // ATOMIC: both set-based upserts commit together, so a mid-reconcile throw can't
    // leave the pool levels aligned but the per-variant ones stale (or vice-versa).
    await db.transaction(async (tx) => {
      await tx.execute(sql`
      INSERT INTO stock_levels (location_id, product_id, variant_id, qty)
      SELECT ${defId}, p.id, NULL, GREATEST(0, p.stock_qty - COALESCE(o.other, 0))
      FROM products p
      LEFT JOIN (
        SELECT sl.product_id, SUM(sl.qty) AS other
        FROM stock_levels sl
        JOIN stock_locations loc ON loc.id = sl.location_id
        WHERE sl.variant_id IS NULL AND sl.location_id <> ${defId}
          AND loc.is_active AND loc.deleted_at IS NULL
        GROUP BY sl.product_id
      ) o ON o.product_id = p.id
      WHERE p.stock_qty IS NOT NULL AND p.deleted_at IS NULL
        AND (
          p.product_type <> 'variable'
          OR COALESCE(p.shared_variant_stock, ${globalDefault}::boolean) IS TRUE
        )
      ON CONFLICT (location_id, product_id) WHERE variant_id IS NULL
      ${conflictAction}
    `);

    // Per-variant levels: default = variant.stock_qty − Σ(other active). Only for
    // GENUINELY per-variant variable products — a SHARED-variant product's
    // authoritative stock is the pool (handled above), while each variant still
    // carries a non-NULL but "ignored" stock_qty (schema.ts). Without this gate a
    // shared product would get BOTH a pool level AND per-variant levels, so the
    // Σ(levels) hints / guards double-count its units.
      await tx.execute(sql`
      INSERT INTO stock_levels (location_id, product_id, variant_id, qty)
      SELECT ${defId}, v.product_id, v.id, GREATEST(0, v.stock_qty - COALESCE(o.other, 0))
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      LEFT JOIN (
        SELECT sl.variant_id, SUM(sl.qty) AS other
        FROM stock_levels sl
        JOIN stock_locations loc ON loc.id = sl.location_id
        WHERE sl.variant_id IS NOT NULL AND sl.location_id <> ${defId}
          AND loc.is_active AND loc.deleted_at IS NULL
        GROUP BY sl.variant_id
      ) o ON o.variant_id = v.id
      WHERE v.stock_qty IS NOT NULL AND v.deleted_at IS NULL
        AND p.deleted_at IS NULL
        AND COALESCE(p.shared_variant_stock, ${globalDefault}::boolean) IS NOT TRUE
      ON CONFLICT (location_id, variant_id) WHERE variant_id IS NOT NULL
      ${conflictAction}
    `);
    });
  }

  /** Make `id` the single default location (clears any previous default first
   *  so the one-default partial-unique index is never violated). Promotes only
   *  an ACTIVE, non-deleted location, checked IN the promote UPDATE (atomic vs
   *  a concurrent deactivation — a stale pre-read would let an inactive
   *  location become an active default without its units going back into the
   *  totals; reactivate via setLocationActive first). Returns false — and rolls
   *  the default-clear back, so the store never ends up without a default —
   *  when the location is missing, deleted or inactive. */
  async setDefault(id: string): Promise<boolean> {
    try {
      await db.transaction(async (tx) => {
        await tx
          .update(stock_locations)
          .set({ is_default: false, updated_at: sql`now()` })
          .where(eq(stock_locations.is_default, true));
        const promoted = await tx
          .update(stock_locations)
          .set({ is_default: true, updated_at: sql`now()` })
          .where(
            and(
              eq(stock_locations.id, id),
              eq(stock_locations.is_active, true),
              isNull(stock_locations.deleted_at),
            ),
          )
          .returning({ id: stock_locations.id });
        if (promoted.length === 0) throw new DefaultNotPromotedError();
      });
    } catch (err) {
      if (err instanceof DefaultNotPromotedError) return false;
      throw err;
    }
    return true;
  }

  /**
   * Batch-read per-location levels for a set of products, keyed
   * `${productId}` (pool) or `${productId}:${variantId}` (variant), each mapping
   * locationId → qty. Drives the multi-location stock table.
   */
  async listLevelsForProducts(
    productIds: string[],
  ): Promise<Map<string, Map<string, number>>> {
    const out = new Map<string, Map<string, number>>();
    if (productIds.length === 0) return out;
    const rows = await db
      .select()
      .from(stock_levels)
      .where(inArray(stock_levels.product_id, productIds));
    for (const r of rows) {
      const key = r.variant_id ? `${r.product_id}:${r.variant_id}` : r.product_id;
      let m = out.get(key);
      if (!m) {
        m = new Map<string, number>();
        out.set(key, m);
      }
      m.set(r.location_id, r.qty);
    }
    return out;
  }

  /**
   * Set the on-hand at ONE location for a target, atomically maintaining the
   * cached total (`products`/`product_variants`.stock_qty) + ledgering the move.
   *
   * Total maintenance is DELTA-based when the target is already tracked, so a
   * concurrent order decrement is preserved (never clobbered by a stale sum);
   * an untracked target (NULL total) transitions to tracked = the sum of its
   * active-location levels. `in_stock` is derived from the new total.
   *
   * The location must exist, be ACTIVE, and not be soft-deleted — editing a
   * level at an inactive/deleted location is rejected (it would either orphan
   * stock outside the active-location SUM or write an orphaned level row).
   * Returns the target's unavailable→available transition so callers can emit
   * `product.updated` (cache bust) + `product.restocked` (back-in-stock email).
   */
  async setLocationLevel(
    target: LevelTarget,
    locationId: string,
    newQty: number,
    ctx: { actorUserId?: string | null; note?: string | null; expectedLevel?: number | null; reason?: StockMovementReason } = {},
  ): Promise<{ productId: string; variantId: string | null; becameAvailable: boolean }> {
    return db.transaction((tx) => this._applyLevelTx(tx, target, locationId, newQty, ctx));
  }

  /**
   * RELATIVE per-location adjust (ERP/WMS sync): change ONE location's on-hand by
   * `delta`, maintaining the cached total + ledger exactly like {@link setLocationLevel}
   * (an absolute set), but computed from the CURRENT level read under the same tx
   * lock — so a concurrent sale/transfer is composed with, never clobbered. Floored
   * at 0. A no-op delta returns the unchanged state. For the per-location `/api/stock`
   * PATCH `{ location, stockDelta }`.
   */
  async adjustLocationLevel(
    target: LevelTarget,
    locationId: string,
    delta: number,
    ctx: { actorUserId?: string | null; note?: string | null; reason?: StockMovementReason } = {},
  ): Promise<{ productId: string; variantId: string | null; becameAvailable: boolean }> {
    const d = Math.trunc(Number(delta) || 0);
    // RELATIVE apply, in the CANONICAL lock order. Previously this pre-locked the
    // level row FOR UPDATE (to read the current qty for the delta) BEFORE
    // _applyLevelTx took location → TOTAL → level — inverting the order to
    // level → TOTAL and opening an AB/BA deadlock against every other writer
    // (a sale / ship / transfer all lock TOTAL then level). _applyLevelTx now
    // composes the delta from the level IT locks (last, after the total), so the
    // pre-lock is gone and this ERP/WMS adjust joins the one serialization order.
    return db.transaction((tx) =>
      this._applyLevelTx(tx, target, locationId, 0, { ...ctx, relativeDelta: d }),
    );
  }

  /**
   * Apply an ABSOLUTE level for one (product/variant, location) on a CALLER-GIVEN
   * transaction. `setLocationLevel` wraps it in its own tx; `evacuateLocation`
   * batches a dest-read + BOTH the dest and source applies into ONE tx so a
   * transfer move is atomic (a crash can't leave units counted at both locations)
   * and the dest read can't lose an update to a concurrent edit. Also returns
   * the target's cached total + in_stock AFTER the write, so evacuateLocation
   * can report the NET effect of its multi-apply move.
   */
  private async _applyLevelTx(
    tx: Tx,
    target: LevelTarget,
    locationId: string,
    newQty: number,
    ctx: {
      actorUserId?: string | null;
      note?: string | null;
      /** Ledger classification for the level change (default "admin"). A transfer
       *  leg passes "transfer" so ERP reconciliation can tell relocations apart. */
      reason?: StockMovementReason;
      /** Originating order, when the move came from an order-driven transfer. */
      orderId?: string | null;
      /** Optimistic compare-and-set: when set, the write is REFUSED (throws
       *  {@link StockConflictError}) unless the LOCKED committed level equals it —
       *  so the per-location matrix's absolute-set can't blindly clobber a level
       *  a transfer/edit moved since the operator loaded the page. Only the
       *  operator-facing setLocationLevel path passes it; the transfer/evacuate/
       *  (de)activate legs omit it and stay last-writer-wins. */
      expectedLevel?: number | null;
      /** RELATIVE mode (ERP/WMS on-hand adjust): when set, the new level is
       *  max(0, LOCKED oldLevel + relativeDelta) composed from the level this tx
       *  locks LAST (canonical order), not the absolute `newQty` arg — so a
       *  relative adjust can't race a concurrent sale/transfer AND needs no
       *  out-of-order pre-lock. Mutually exclusive with expectedLevel in practice. */
      relativeDelta?: number | null;
    } = {},
  ): Promise<{
    productId: string;
    variantId: string | null;
    becameAvailable: boolean;
    newTotal: number;
    newInStock: boolean;
  }> {
    const isVariant = target.variantId != null;
    const absClamped = Math.max(0, Math.floor(Number(newQty) || 0));

    {
      // The location must exist, be active, and not be soft-deleted. FOR SHARE
      // (canonical lock order: location → TOTAL → level) so a concurrent
      // setLocationActive — which row-locks the location before moving the
      // totals by its levels — can't flip it mid-write: either this write
      // commits first (and the flip then reads the fresh level), or it waits and
      // re-reads the location as inactive.
      const [loc] = await tx
        .select({ active: stock_locations.is_active })
        .from(stock_locations)
        .where(and(eq(stock_locations.id, locationId), isNull(stock_locations.deleted_at)))
        .limit(1)
        .for("share");
      if (!loc || !loc.active) {
        throw new Error("Emplacement introuvable ou inactif.");
      }

      // Lock the total row (also read in_stock to detect the availability flip).
      const totalRowId = isVariant ? target.variantId! : target.productId;
      const [totalRow] = isVariant
        ? await tx
            .select({
              productId: product_variants.product_id,
              qty: product_variants.stock_qty,
              inStock: product_variants.in_stock,
            })
            .from(product_variants)
            .where(eq(product_variants.id, totalRowId))
            .for("update")
        : await tx
            .select({ qty: products.stock_qty, inStock: products.in_stock })
            .from(products)
            .where(eq(products.id, totalRowId))
            .for("update");
      const oldTotal = totalRow?.qty ?? null;
      const wasAvailable = (totalRow?.inStock ?? false) && (oldTotal == null || oldTotal > 0);

      // IDOR / cross-product integrity guard: a variant id MUST belong to the
      // claimed product. `stock_levels` carries only single-column FKs
      // (product_id→products, variant_id→product_variants) and NO composite FK,
      // so a crafted (productId=A, variantId=B) pair would otherwise corrupt
      // product B's stock_qty, write a mismatched stock_levels(product_id=A,
      // variant_id=B) row the DB accepts, and fire product.updated on the wrong
      // product. Mirrors the boutique guard in lib/actions/catalog.ts.
      if (isVariant) {
        const vProductId = (totalRow as { productId?: string } | undefined)?.productId;
        if (!vProductId || vProductId !== target.productId) {
          throw new Error("Variante introuvable pour ce produit.");
        }
      }

      // Read + lock the existing level row.
      const levelWhere = and(
        eq(stock_levels.location_id, locationId),
        eq(stock_levels.product_id, target.productId),
        isVariant ? eq(stock_levels.variant_id, target.variantId!) : isNull(stock_levels.variant_id),
      );
      const [lvl] = await tx.select().from(stock_levels).where(levelWhere).for("update");
      const oldLevel = lvl?.qty ?? 0;
      // RELATIVE mode composes the delta with the level JUST locked (canonical
      // order already established above); ABSOLUTE mode uses the caller's newQty.
      const clamped =
        ctx.relativeDelta != null
          ? Math.max(0, oldLevel + Math.trunc(Number(ctx.relativeDelta) || 0))
          : absClamped;
      // Optimistic compare-and-set: refuse a stale absolute-set (the operator's
      // page-load level no longer matches the committed one — a transfer landed
      // here, or another edit) instead of clobbering it and dropping the total.
      if (ctx.expectedLevel != null && ctx.expectedLevel !== oldLevel) {
        throw new StockConflictError(ctx.expectedLevel, oldLevel);
      }
      const delta = clamped - oldLevel;

      if (lvl) {
        await tx
          .update(stock_levels)
          .set({ qty: clamped, updated_at: sql`now()` })
          .where(eq(stock_levels.id, lvl.id));
      } else {
        await tx.insert(stock_levels).values({
          location_id: locationId,
          product_id: target.productId,
          variant_id: target.variantId,
          qty: clamped,
        });
      }

      // Maintain the cached total. Only the untracked→tracked case needs the
      // sum of active-location levels (computed AFTER the upsert above).
      let sumActive = clamped;
      if (oldTotal == null) {
        const [sumRow] = await tx
          .select({ s: sql<number>`coalesce(sum(${stock_levels.qty}), 0)` })
          .from(stock_levels)
          .innerJoin(stock_locations, eq(stock_levels.location_id, stock_locations.id))
          .where(
            and(
              eq(stock_levels.product_id, target.productId),
              isVariant
                ? eq(stock_levels.variant_id, target.variantId!)
                : isNull(stock_levels.variant_id),
              eq(stock_locations.is_active, true),
              isNull(stock_locations.deleted_at),
            ),
          );
        sumActive = Number(sumRow?.s ?? clamped);
      }
      const newTotal = nextTotalForLevelWrite(oldTotal, delta, sumActive);
      // in_stock follows the shared sold-out rule (in-stock-rule.ts): a SOLD-OUT
      // total re-lists once units arrive, an emptied total de-lists, but a line
      // the operator deliberately delisted (in_stock=false with units) stays
      // delisted through a per-location edit (was: blindly `newTotal > 0`).
      const newInStock = nextInStockForQty(oldTotal, totalRow?.inStock ?? false, newTotal);

      if (isVariant) {
        await tx
          .update(product_variants)
          .set({ stock_qty: newTotal, in_stock: newInStock, updated_at: sql`now()` })
          .where(eq(product_variants.id, totalRowId));
      } else {
        await tx
          .update(products)
          .set({ stock_qty: newTotal, in_stock: newInStock, updated_at: sql`now()` })
          .where(eq(products.id, totalRowId));
      }

      if (delta !== 0) {
        await stockMovementService.record(
          {
            productId: target.productId,
            variantId: target.variantId,
            delta,
            resultingQty: newTotal,
            reason: ctx.reason ?? "admin",
            orderId: ctx.orderId ?? null,
            locationId,
            actorUserId: ctx.actorUserId ?? null,
            note: ctx.note ?? null,
          },
          tx,
        );
      }

      // Report the unavailable→available flip (quantity-aware availability).
      const becameAvailable = !wasAvailable && isAvailable(newInStock, newTotal);
      return { productId: target.productId, variantId: target.variantId, becameAvailable, newTotal, newInStock };
    }
  }

  /**
   * Move `qty` of a target from one ACTIVE location to another, on a caller-given
   * transaction, as two `transfer` ledger legs (−qty at source, +qty at dest).
   * The cached product/variant TOTAL is INVARIANT — a move between two active
   * locations doesn't change the sum-of-active-levels — so the two `_applyLevelTx`
   * calls net the total to zero while relocating the units + logging the move.
   * Validates the SOURCE physically holds the units (no negative level). Reuses
   * _applyLevelTx so the active-location check, the IDOR guard, in_stock
   * derivation and the ledger all stay identical to a normal level edit.
   *
   * Called per item by the transfer workflow inside ONE tx, so a multi-item
   * completion is all-or-nothing. Locks the shared TOTAL row FOR UPDATE first
   * (the serialization point every level writer takes), so reading the source /
   * destination levels here is stable against a concurrent decrement / edit.
   */
  async moveStockTx(
    tx: Tx,
    target: LevelTarget,
    fromLocationId: string,
    toLocationId: string,
    qty: number,
    ctx: { actorUserId?: string | null; orderId?: string | null; note?: string | null } = {},
  ): Promise<void> {
    const move = Math.max(0, Math.floor(Number(qty) || 0));
    if (move === 0) return;
    if (fromLocationId === toLocationId) throw new Error("Source et destination identiques.");
    const isVariant = target.variantId != null;

    // Canonical lock order is location → TOTAL → level. Lock BOTH endpoint
    // locations FOR SHARE first, in id order, so this transfer path can't
    // ABBA-deadlock against setLocationActive / evacuateLocation (which lock the
    // location THEN the total), nor against another concurrent moveStockTx.
    for (const locId of [fromLocationId, toLocationId].sort()) {
      await tx.select({ id: stock_locations.id }).from(stock_locations).where(eq(stock_locations.id, locId)).for("share");
    }

    // Lock the shared TOTAL row FOR UPDATE (+ variant→product IDOR guard). This is
    // the serialization point every level writer takes — setLocationLevel AND
    // adjustLevelOnly (the ship decrement) both lock it — so the level reads below
    // can't be raced by a concurrent decrement into/out of these locations.
    const totalRowId = isVariant ? target.variantId! : target.productId;
    if (isVariant) {
      const [v] = await tx
        .select({ productId: product_variants.product_id })
        .from(product_variants)
        .where(eq(product_variants.id, totalRowId))
        .for("update");
      if (!v || v.productId !== target.productId) throw new Error("Variante introuvable pour ce produit.");
    } else {
      await tx.select({ id: products.id }).from(products).where(eq(products.id, totalRowId)).for("update");
    }

    const readLevel = async (locationId: string) => {
      const [lvl] = await tx
        .select({ qty: stock_levels.qty })
        .from(stock_levels)
        .where(
          and(
            eq(stock_levels.location_id, locationId),
            eq(stock_levels.product_id, target.productId),
            isVariant ? eq(stock_levels.variant_id, target.variantId!) : isNull(stock_levels.variant_id),
          ),
        )
        .limit(1);
      return lvl?.qty ?? 0;
    };
    const srcQty = await readLevel(fromLocationId);
    if (srcQty < move) {
      throw new Error(`Stock source insuffisant pour le transfert (${srcQty} disponible, ${move} demandé).`);
    }
    const destQty = await readLevel(toLocationId);

    const legCtx = { reason: "transfer" as const, actorUserId: ctx.actorUserId ?? null, orderId: ctx.orderId ?? null, note: ctx.note ?? null };
    // DESTINATION +move first, then source −move: the two total deltas cancel out
    // (the sum-of-active-levels is invariant), but dest-first keeps the
    // intermediate cached total > 0. Source-first would drive the total through 0
    // when the whole stock is being moved, and _applyLevelTx's in_stock rule
    // (in-stock-rule.ts) treats a 0-crossing as "sold out" → the destination leg
    // would then RE-LIST a deliberately-delisted product (in_stock false→true).
    // Mirrors evacuateLocation, which also applies the destination leg first.
    await this._applyLevelTx(tx, target, toLocationId, destQty + move, legCtx);
    await this._applyLevelTx(tx, target, fromLocationId, srcQty - move, legCtx);
  }

  /**
   * Adjust ONE location's physical level by `delta` WITHOUT touching the cached
   * TOTAL — unlike setLocationLevel/_applyLevelTx, which keep total = Σ(levels).
   * Used by the order lifecycle where the total already moved at PLACEMENT (the
   * sale decremented stock_qty): a SHIPMENT then records the goods physically
   * leaving the depot (delta < 0), so the level catches up to the total that was
   * already reduced. Clamped at 0 (a level can't go negative); an untracked target
   * (NULL total) is skipped. Ledgered with the caller's reason + location + order.
   * Opens its own tx (called post-commit from a subscriber, per shipment line).
   */
  async adjustLevelOnly(
    target: LevelTarget,
    locationId: string,
    delta: number,
    ctx: { reason: StockMovementReason; orderId?: string | null; actorUserId?: string | null; note?: string | null },
  ): Promise<void> {
    const d = Math.trunc(Number(delta) || 0);
    if (d === 0) return;
    const isVariant = target.variantId != null;
    return db.transaction(async (tx) => {
      // Lock the TOTAL row FOR UPDATE — even though this move does NOT change it —
      // so this joins the SAME serialization point every other level writer takes
      // (setLocationLevel, moveStockTx). Without it, a transfer completing into a
      // location could clobber this decrement and re-count shipped units as
      // sellable. Also skips untracked targets + carries the total as resulting_qty.
      const totalRowId = isVariant ? target.variantId! : target.productId;
      const [totalRow] = isVariant
        ? await tx.select({ q: product_variants.stock_qty }).from(product_variants).where(eq(product_variants.id, totalRowId)).for("update")
        : await tx.select({ q: products.stock_qty }).from(products).where(eq(products.id, totalRowId)).for("update");
      const total = totalRow?.q ?? null;
      if (total == null) return; // untracked = unlimited; no per-location level to move

      const levelWhere = and(
        eq(stock_levels.location_id, locationId),
        eq(stock_levels.product_id, target.productId),
        isVariant ? eq(stock_levels.variant_id, target.variantId!) : isNull(stock_levels.variant_id),
      );
      const [lvl] = await tx.select().from(stock_levels).where(levelWhere).for("update");
      const current = lvl?.qty ?? 0;
      const next = Math.max(0, current + d);
      const applied = next - current;
      if (applied === 0) return; // clamped to a no-op (e.g. shipping more than the level holds)

      if (lvl) {
        await tx.update(stock_levels).set({ qty: next, updated_at: sql`now()` }).where(eq(stock_levels.id, lvl.id));
      } else {
        await tx.insert(stock_levels).values({
          location_id: locationId,
          product_id: target.productId,
          variant_id: target.variantId,
          qty: next,
        });
      }
      await stockMovementService.record(
        {
          productId: target.productId,
          variantId: target.variantId,
          delta: applied,
          resultingQty: total,
          reason: ctx.reason,
          orderId: ctx.orderId ?? null,
          locationId,
          actorUserId: ctx.actorUserId ?? null,
          note: ctx.note ?? null,
        },
        tx,
      );
    });
  }

  /**
   * Empty a location's stock before it's deleted, via _applyLevelTx (so every
   * cached total + ledger row stays correct):
   *   - "transfer" → each level is added to `destinationId` then zeroed at the
   *     source, so the totals are unchanged (stock just moved stores);
   *   - "writeoff" → each level is zeroed, so the totals DROP by what was there.
   * An INACTIVE source's units were already taken out of the totals when it was
   * deactivated (setLocationActive, which also clamped each level to what it
   * removed), so its levels are zeroed WITHOUT touching the totals — a writeoff
   * removes nothing more (no double-subtract) and a transfer's destination apply
   * adds exactly the removed units back as sellable.
   * Returns how many (product/variant) lines were moved, plus — like
   * setLocationActive — the products whose cached total / in_stock NET-changed
   * (→ `product.updated` cache bust; an active-source transfer nets to zero) and
   * the ones that went unavailable → available (→ `product.restocked`, e.g. an
   * inactive source's units transferred back into a sold-out line), for the
   * caller to emit post-commit. A line failing mid-way throws an
   * EvacuatePartialError carrying the same two lists for the lines already
   * committed. Capped — a very large evacuation should be done in the Stock
   * table instead.
   */
  async evacuateLocation(
    srcId: string,
    opts: { mode: "transfer" | "writeoff"; destinationId?: string; actorUserId?: string | null },
  ): Promise<{ moved: number; touchedProductIds: string[]; restockedProductIds: string[] }> {
    if (opts.mode === "transfer") {
      if (!opts.destinationId || opts.destinationId === srcId) {
        throw new Error("Emplacement de destination invalide.");
      }
      const dest = await this.findById(opts.destinationId);
      if (!dest || !dest.is_active) {
        throw new Error("Emplacement de destination introuvable ou inactif.");
      }
    }

    const levels = await db
      .select()
      .from(stock_levels)
      .where(and(eq(stock_levels.location_id, srcId), gt(stock_levels.qty, 0)));
    if (levels.length > 2000) {
      throw new Error("Trop de références à déplacer — videz l'emplacement via le tableau Stock.");
    }

    const note =
      opts.mode === "transfer"
        ? "Transfert (suppression d'emplacement)"
        : "Retrait du stock (suppression d'emplacement)";
    const touched = new Set<string>();
    const restocked = new Set<string>();
    for (const lvl of levels) {
      const target: LevelTarget = { productId: lvl.product_id, variantId: lvl.variant_id };
      // ATOMIC per line in ONE transaction so a crash can't double-count. Lock in
      // the CANONICAL order every other path uses — location(s) FOR SHARE, then
      // the TOTAL row, then the level rows — to avoid an ABBA deadlock against a
      // concurrent setLocationLevel (location→TOTAL→LEVEL) or setLocationActive
      // (location→TOTALs). Move the FRESH, locked source qty (not the stale
      // batch-read lvl.qty) so the amount added to the dest exactly equals the
      // amount removed from the source even if the source changed since the batch
      // read. The re-locks inside _applyLevelTx are re-entrant (same tx); for an
      // active source the two transfer applies net to zero total change.
      const variantId = lvl.variant_id;
      const lineOut = await db.transaction(async (tx) => {
        // 0) Location rows first, in id order. The source's active flag is read
        //    under the lock, so a concurrent (de)activation can't slip between.
        const locIds = opts.mode === "transfer" ? [srcId, opts.destinationId!].sort() : [srcId];
        const locRows = await tx
          .select({ id: stock_locations.id, active: stock_locations.is_active })
          .from(stock_locations)
          .where(inArray(stock_locations.id, locIds))
          .orderBy(asc(stock_locations.id))
          .for("share");
        const srcActive = locRows.find((r) => r.id === srcId)?.active ?? false;
        // 1) TOTAL row (product-pool or the specific variant) — its locked
        //    pre-move state is the baseline for the NET change reported below.
        const [before] = variantId
          ? await tx
              .select({ qty: product_variants.stock_qty, inStock: product_variants.in_stock })
              .from(product_variants)
              .where(eq(product_variants.id, variantId))
              .for("update")
          : await tx
              .select({ qty: products.stock_qty, inStock: products.in_stock })
              .from(products)
              .where(eq(products.id, lvl.product_id))
              .for("update");
        const variantMatch = variantId
          ? eq(stock_levels.variant_id, variantId)
          : isNull(stock_levels.variant_id);
        const srcWhere = and(
          eq(stock_levels.location_id, srcId),
          eq(stock_levels.product_id, lvl.product_id),
          variantMatch,
        );
        // 2) Source level FOR UPDATE — the fresh moved quantity.
        const [s] = await tx.select({ qty: stock_levels.qty }).from(stock_levels).where(srcWhere).for("update");
        const srcQty = s?.qty ?? 0;
        if (srcQty <= 0) return null; // nothing left to move (a concurrent edit drained it)
        // The target's total after the LAST total-moving apply (null = none ran).
        let after: { newTotal: number; newInStock: boolean } | null = null;
        if (opts.mode === "transfer") {
          // 3) Destination level FOR UPDATE.
          const [d] = await tx
            .select({ qty: stock_levels.qty })
            .from(stock_levels)
            .where(and(eq(stock_levels.location_id, opts.destinationId!), eq(stock_levels.product_id, lvl.product_id), variantMatch))
            .for("update");
          after = await this._applyLevelTx(tx, target, opts.destinationId!, (d?.qty ?? 0) + srcQty, {
            actorUserId: opts.actorUserId,
            note,
          });
        }
        if (srcActive) {
          after = await this._applyLevelTx(tx, target, srcId, 0, { actorUserId: opts.actorUserId, note });
        } else {
          // Inactive source: its units are already OUT of the totals — just
          // zero the level (no total change → nothing to ledger).
          await tx.update(stock_levels).set({ qty: 0, updated_at: sql`now()` }).where(srcWhere);
        }
        if (!after || !before) return null;
        return {
          changed: after.newTotal !== before.qty || after.newInStock !== before.inStock,
          restocked: !isAvailable(before.inStock, before.qty) && isAvailable(after.newInStock, after.newTotal),
        };
      }).catch((err: unknown) => {
        // This line rolled back, but the earlier ones committed — hand their
        // effects to the caller so it can still emit them.
        throw new EvacuatePartialError(
          err instanceof Error ? err.message : "Impossible de déplacer le stock.",
          [...touched],
          [...restocked],
        );
      });
      if (lineOut?.changed) touched.add(lvl.product_id);
      if (lineOut?.restocked) restocked.add(lvl.product_id);
    }
    return { moved: levels.length, touchedProductIds: [...touched], restockedProductIds: [...restocked] };
  }

  /**
   * Activate / deactivate a location, moving the cached totals by DELTA: every
   * tracked product/variant holding units here has its total lowered by that
   * level on deactivation (the units stop being sellable) and raised by it on
   * reactivation — floored at 0, one `admin` ledger row per change (with the
   * location id). NEVER a recompute as Σ(levels): order decrements move only
   * the totals (per-location decrement is a later phase), so the level sum is
   * stale by every sale since the last matrix edit and overwriting the total
   * with it would resurrect sold units.
   *
   * SYMMETRIC: a deactivation whose level exceeds the total (sales drained the
   * total below it) removes only the total, and clamps the frozen level to that
   * amount — so the reactivation (or an inactive-source transfer on delete)
   * adds back exactly what was taken out, never the sold units.
   *
   * One transaction. The guarded UPDATE row-locks the location first (level
   * writers take FOR SHARE on it — see _applyLevelTx — so no level here moves
   * until commit and the levels read below are stable); the affected TOTAL rows
   * are then locked in id order. A no-op (already in that state, not found /
   * deleted, or deactivating the default) returns `changed: false` without
   * touching any total — so a double submit can never double-subtract.
   * in_stock follows the shared sold-out rule (in-stock-rule.ts). Returns the
   * touched product ids (→ `product.updated` cache bust) and the ones that went
   * unavailable → available (→ `product.restocked`), for the caller to emit
   * post-commit.
   */
  async setLocationActive(
    locationId: string,
    active: boolean,
    ctx: { actorUserId?: string | null } = {},
  ): Promise<{ changed: boolean; touchedProductIds: string[]; restockedProductIds: string[] }> {
    return db.transaction(async (tx) => {
      const flipped = await tx
        .update(stock_locations)
        .set({ is_active: active, updated_at: sql`now()` })
        .where(
          and(
            eq(stock_locations.id, locationId),
            isNull(stock_locations.deleted_at),
            ne(stock_locations.is_active, active),
            // The default location can't be deactivated (setDefault forces active).
            active ? undefined : eq(stock_locations.is_default, false),
          ),
        )
        .returning({ id: stock_locations.id });
      if (flipped.length === 0) {
        return { changed: false, touchedProductIds: [], restockedProductIds: [] };
      }

      const levels = await tx
        .select({
          id: stock_levels.id,
          productId: stock_levels.product_id,
          variantId: stock_levels.variant_id,
          qty: stock_levels.qty,
        })
        .from(stock_levels)
        .where(and(eq(stock_levels.location_id, locationId), gt(stock_levels.qty, 0)));

      // Lock every affected TOTAL row up-front, in a deterministic id order.
      const poolIds = [...new Set(levels.filter((l) => l.variantId == null).map((l) => l.productId))];
      const variantIds = [...new Set(levels.flatMap((l) => (l.variantId ? [l.variantId] : [])))];
      const poolRows = poolIds.length
        ? await tx
            .select({ id: products.id, qty: products.stock_qty, inStock: products.in_stock })
            .from(products)
            .where(inArray(products.id, poolIds))
            .orderBy(asc(products.id))
            .for("update")
        : [];
      const variantRows = variantIds.length
        ? await tx
            .select({ id: product_variants.id, qty: product_variants.stock_qty, inStock: product_variants.in_stock })
            .from(product_variants)
            .where(inArray(product_variants.id, variantIds))
            .orderBy(asc(product_variants.id))
            .for("update")
        : [];
      const poolById = new Map(poolRows.map((r) => [r.id, r]));
      const variantById = new Map(variantRows.map((r) => [r.id, r]));

      const sign = active ? 1 : -1;
      const note = active ? "Emplacement réactivé" : "Emplacement désactivé";
      const touched = new Set<string>();
      const restocked = new Set<string>();
      // One level per (location, product-pool) and per (location, variant) —
      // partial-unique indexes — so each total row is visited at most once.
      for (const lvl of levels) {
        const row = lvl.variantId ? variantById.get(lvl.variantId) : poolById.get(lvl.productId);
        // Gone, or untracked (NULL = unlimited): no total to move.
        if (!row || row.qty == null) continue;
        // A level ABOVE the whole total is provably overstated — sales moved the
        // total but not the level (per-location decrement is deferred), and a
        // location can't hold more than every location together. Deactivation
        // removes only min(level, total), so clamp the frozen level to exactly
        // what came out: the reactivation (or an inactive-source transfer) then
        // adds back that amount and never resurrects sold units (was level 5,
        // total 3 → 0 → 5). Before the delta-0 skip, so a sold-out total (0)
        // clamps the level to 0 too. Race-safe: the UPDATE above row-locks the
        // location and every level writer takes FOR SHARE on it first.
        if (!active && lvl.qty > row.qty) {
          await tx
            .update(stock_levels)
            .set({ qty: row.qty, updated_at: sql`now()` })
            .where(eq(stock_levels.id, lvl.id));
        }
        const newTotal = Math.max(0, row.qty + sign * lvl.qty);
        const delta = newTotal - row.qty;
        if (delta === 0) continue; // e.g. deactivating onto an already-empty total
        const newInStock = nextInStockForQty(row.qty, row.inStock, newTotal);

        if (lvl.variantId) {
          await tx
            .update(product_variants)
            .set({ stock_qty: newTotal, in_stock: newInStock, updated_at: sql`now()` })
            .where(eq(product_variants.id, lvl.variantId));
        } else {
          await tx
            .update(products)
            .set({ stock_qty: newTotal, in_stock: newInStock, updated_at: sql`now()` })
            .where(eq(products.id, lvl.productId));
        }
        await stockMovementService.record(
          {
            productId: lvl.productId,
            variantId: lvl.variantId,
            delta,
            resultingQty: newTotal,
            reason: "admin",
            locationId,
            actorUserId: ctx.actorUserId ?? null,
            note,
          },
          tx,
        );
        touched.add(lvl.productId);
        if (!isAvailable(row.inStock, row.qty) && isAvailable(newInStock, newTotal)) {
          restocked.add(lvl.productId);
        }
      }
      return { changed: true, touchedProductIds: [...touched], restockedProductIds: [...restocked] };
    });
  }
}

export const stockLocationService = new StockLocationService();
